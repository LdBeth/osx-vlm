/* -*- Mode: C; Tab-Width: 4 -*- */

/* Embedded Chaosnet MINI cold-load file server.
 *
 * MINI is the protocol a Genera cold load uses to fetch the rest of the
 * operating system from its SYS host during SI:QLD (client: SYS:IO;LMINI,
 * primitives: SYS:NETWORK;IVORY-ETHERNET-DRIVER).  Symbolics never shipped
 * the server.  This one lives inside the emulator's Darwin network backend:
 * the transmitter hands us every guest frame addressed to the server's
 * chaos address (plus ARP requests for it), and our replies are injected
 * straight into the host->guest queue -- the traffic never reaches vmnet,
 * so the server also works in the --without-vmnet (rootless) build.
 *
 * Wire contract, reconstructed from LMINI (all client constants octal):
 *   - Chaos-over-Ethernet (0x0804) with ARP (0x0806, hw 1, proto 0x0804).
 *   - Chaos header: 8 little-endian 16-bit words -- opcode<<8, length
 *     (low 12 bits, in bytes), dest, dest-index, source, source-index,
 *     packet#, ack#.  Data at byte 16, max 488 bytes.
 *   - Client sends RFC (contact "MINI LISPM "); we OPN; window size is 1
 *     and the client STS-acks every controlled packet, so exactly one
 *     unacknowledged packet is ever outstanding and it is retransmitted
 *     on timeout.
 *   - File requests are opcode 0200 (character) / 0201 (binary) with the
 *     logical pathname verbatim ("SYS:SYS;MINI-ALISTS.VBIN.NEWEST"); the
 *     server does the SYS: translation.  Response 0202 (won) / 0203
 *     (lost) carries truename + CR (0215) + 32-bit universal time as four
 *     raw bytes (this is the Genera 8.5 delta from the CADR-era servers,
 *     which sent a textual date).  Data flows as 0200 (character,
 *     already-Lispm-charset bytes) or 0300 (binary 16-bit words) packets,
 *     then EOF (014).  The connection persists across files.
 *
 * The protocol core below is pure (no emulator headers, frames in, frames
 * out via callback, caller-supplied clock) and compiles standalone under
 * -DMINI_STANDALONE for the unit harness in mini-server-test.c.
 *
 * The server owns its chaos address outright: every frame addressed to it,
 * including chaos-ARP, is answered in-process and never reaches the wire.
 * It therefore cannot share the address with a real host -- for that, run
 * the Lisp MINI server on a second VLM instead (route-b/mini-server.lisp).
 */

#ifdef MINI_STANDALONE
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <ctype.h>
#include <sys/stat.h>
typedef int boolean;
#ifndef TRUE
#define TRUE 1
#define FALSE 0
#endif
#define ETH_P_CHAOS 0x0804
#define ETH_P_ARP 0x0806
#define MAX_CHAOS_DATA_BYTES 488
#define CHAOS_OP_RFC 0x01
#define CHAOS_OP_OPN 0x02
#define CHAOS_OP_CLS 0x03
#define CHAOS_OP_STS 0x07
#define CHAOS_OP_LOS 0x09
#define CHAOS_OP_EOF 0x0C
#define MINI_WARN(...) (fprintf (stderr, "mini: " __VA_ARGS__), fputc ('\n', stderr))
#else
#include <ctype.h>
#include <stdlib.h>
#include <sys/stat.h>
#define MINI_WARN(...) vwarn ("mini", __VA_ARGS__)
#endif

#ifdef DEBUG_MINI
#define MINI_TRACE(...) (fprintf (stderr, "mini: " __VA_ARGS__), fputc ('\n', stderr))
#else
#define MINI_TRACE(...)
#endif

/* MINI opcodes within the connection (octal in the Lisp sources) */
#define MINI_REQ_ASCII	0x80			/* 0200: open character file */
#define MINI_REQ_BINARY	0x81			/* 0201: open binary file */
#define MINI_ANS_WON	0x82			/* 0202: open succeeded */
#define MINI_ANS_LOST	0x83			/* 0203: open failed */
#define MINI_DAT_ASCII	0x80			/* 0200: character data */
#define MINI_DAT_BINARY	0xC0			/* 0300: 16-bit binary data */

#define MINI_ETH_HEADER	14
#define MINI_CHAOS_HEADER 16
#define MINI_MAX_FRAME	(MINI_ETH_HEADER + MINI_CHAOS_HEADER + MAX_CHAOS_DATA_BYTES)

/* Seconds from the universal-time epoch (1900-01-01 GMT) to the Unix epoch */
#define MINI_UT_UNIX_EPOCH 2208988800UL

/* Retransmit the outstanding packet after this long without an ack, and
   give up (LOS) after this many attempts.  The client's own patience is
   5 seconds per packet with 10 retries around connection establishment. */
#define MINI_RETRANSMIT_MS	300
#define MINI_MAX_RETRIES	100


/*** Pure protocol core ***/

typedef void (*MiniEmitFn) (void* ctx, const unsigned char* frame, size_t nBytes);

typedef struct
  {
	/* Configuration */
	unsigned short myAddr;				/* Chaos address we serve (0401) */
	unsigned short guestAddr;			/* Guest's chaos address (0402); informational */
	unsigned char myMac[6];
	char root[1024];					/* SYS: translation root */
	MiniEmitFn emit;
	void* emitCtx;

	/* Connection (a single one; a new RFC always wins) */
	enum { MINI_IDLE, MINI_OPEN } state;
	unsigned char clientMac[6];
	unsigned short clientAddr;
	unsigned short clientIndex;
	unsigned short myIndex;
	unsigned short rfcNum;				/* Packet number of the RFC we accepted */
	unsigned short pktNumIn;			/* Last client controlled packet accepted */
	unsigned short pktNumOut;			/* Number of the last controlled packet sent */

	/* The single outstanding controlled packet (window size 1) */
	unsigned char outFrame[MINI_MAX_FRAME];
	size_t outBytes;
	boolean outstanding;
	uint64_t sentAtMs;
	int retries;
	/* The OPN is kept separately so a duplicate RFC can be answered even
	   after the connection has moved on */
	unsigned char opnFrame[MINI_MAX_FRAME];
	size_t opnBytes;

	/* Current transfer */
	enum { XFER_NONE, XFER_DATA, XFER_EOF } xfer;
	FILE* file;
	boolean binary;

	/* Meters */
	unsigned long nFilesServed, nFilesFailed, nRetransmits;
  }		MiniCore;


static unsigned short mini_get16 (const unsigned char* p)
{
	return (unsigned short) (p[0] | (p[1] << 8));
}

static void mini_put16 (unsigned char* p, unsigned short v)
{
	p[0] = (unsigned char) (v & 0xFF);
	p[1] = (unsigned char) (v >> 8);
}

static unsigned short mini_inc16 (unsigned short v)
{
	return (unsigned short) ((v + 1) & 0xFFFF);
}

/* TRUE when a >= b in 16-bit sequence space */
static boolean mini_seq_geq (unsigned short a, unsigned short b)
{
	return ((short) (unsigned short) (a - b)) >= 0;
}

static void mini_core_init (MiniCore* c, unsigned short myAddr, unsigned short guestAddr,
							const char* root, MiniEmitFn emit, void* emitCtx)
{
	memset (c, 0, sizeof (MiniCore));
	c->myAddr = myAddr;
	c->guestAddr = guestAddr;
	strncpy (c->root, root, sizeof (c->root) - 1);
	/* Locally-administered MAC, "CHAOS" */
	c->myMac[0] = 0x02; c->myMac[1] = 0x43; c->myMac[2] = 0x48;
	c->myMac[3] = 0x41; c->myMac[4] = 0x4F; c->myMac[5] = 0x53;
	c->emit = emit;
	c->emitCtx = emitCtx;
	c->state = MINI_IDLE;
	c->xfer = XFER_NONE;
	c->file = NULL;
}

static void mini_close_file (MiniCore* c)
{
	if (c->file != NULL)
	  {
		fclose (c->file);
		c->file = NULL;
	  }
	c->xfer = XFER_NONE;
}


/*** SYS: logical pathname translation ***/

/* Translate a request like "SYS:SYS;MINI-ALISTS.VBIN.NEWEST" (spaces after
   the colon/semicolons optional, any number of directory components) into
   a host path under the root and a truename for the 0202 response.  The
   version, if any, is ignored: the tree holds unversioned files.  A
   missing type defaults by transfer mode (vbin/lisp).  Returns FALSE for
   requests that don't parse or would escape the root. */

static boolean mini_translate (const MiniCore* c, const char* request, boolean binary,
							   char* path, size_t pathSize,
							   char* truename, size_t truenameSize)
{
  char work[MAX_CHAOS_DATA_BYTES + 1];
  char* tokens[16];
  int nTokens = 0;
  char* p;
  char* fileName;
  char* fileType;
  char* dot;
  size_t pathLen, truenameLen;
  int i;

	strncpy (work, request, sizeof (work) - 1);
	work[sizeof (work) - 1] = 0;

	/* Host component */
	p = strchr (work, ':');
	if (NULL == p)
		return (FALSE);
	*p++ = 0;
	{
	  char* host = work;
	  char* hostEnd;
		while (*host == ' ') host++;
		hostEnd = host + strlen (host);
		while (hostEnd > host && hostEnd[-1] == ' ') *--hostEnd = 0;
		if (strcasecmp (host, "SYS") != 0)
			return (FALSE);
	}

	/* Directory components and the file name, separated by semicolons */
	while (nTokens < (int) (sizeof (tokens) / sizeof (tokens[0])))
	  {
		char* semi = strchr (p, ';');
		char* end;
		while (*p == ' ') p++;
		end = (semi != NULL) ? semi : p + strlen (p);
		while (end > p && end[-1] == ' ') end--;
		*end = 0;
		if (0 == p[0])
			return (FALSE);					/* Empty component */
		if (strchr (p, '/') != NULL || 0 == strcmp (p, "..") || p[0] == '.')
			return (FALSE);					/* Would escape the root */
		tokens[nTokens++] = p;
		if (NULL == semi)
			break;
		p = semi + 1;
	  }
	if (nTokens < 1)
		return (FALSE);

	/* The last token is NAME[.TYPE[.VERSION]] */
	fileName = tokens[--nTokens];
	fileType = NULL;
	dot = strchr (fileName, '.');
	if (dot != NULL)
	  {
		*dot++ = 0;
		fileType = dot;
		dot = strchr (fileType, '.');
		if (dot != NULL)
			*dot = 0;						/* Version dropped: tree is unversioned */
	  }
	if (0 == fileName[0])
		return (FALSE);
	if (NULL == fileType || 0 == fileType[0])
		fileType = binary ? "VBIN" : "LISP";

	/* Host path: root/dir1/…/dirN/name.type, lowercased */
	pathLen = (size_t) snprintf (path, pathSize, "%s", c->root);
	for (i = 0; i < nTokens && pathLen < pathSize; i++)
		pathLen += (size_t) snprintf (path + pathLen, pathSize - pathLen, "/%s", tokens[i]);
	if (pathLen < pathSize)
		pathLen += (size_t) snprintf (path + pathLen, pathSize - pathLen, "/%s.%s",
									  fileName, fileType);
	if (pathLen >= pathSize)
		return (FALSE);
	for (p = path + strlen (c->root); *p != 0; p++)
		*p = (char) tolower ((unsigned char) *p);

	/* Truename: canonical spaced logical pathname with an explicit version */
	truenameLen = (size_t) snprintf (truename, truenameSize, "SYS:");
	for (i = 0; i < nTokens && truenameLen < truenameSize; i++)
		truenameLen += (size_t) snprintf (truename + truenameLen,
										  truenameSize - truenameLen, " %s;", tokens[i]);
	if (truenameLen < truenameSize)
		truenameLen += (size_t) snprintf (truename + truenameLen,
										  truenameSize - truenameLen,
										  " %s.%s.1", fileName, fileType);
	if (truenameLen >= truenameSize)
		return (FALSE);
	for (p = truename; *p != 0; p++)
		*p = (char) toupper ((unsigned char) *p);
	return (TRUE);
}


/*** Frame builders ***/

static void mini_emit_chaos (MiniCore* c, unsigned char opcode,
							 unsigned short num, const unsigned char* data, size_t nBytes,
							 unsigned char* saveFrame, size_t* saveBytes)
{
  unsigned char frame[MINI_MAX_FRAME];
  unsigned char* ch = frame + MINI_ETH_HEADER;
  size_t frameBytes;

	if (nBytes > MAX_CHAOS_DATA_BYTES)
		nBytes = MAX_CHAOS_DATA_BYTES;

	memcpy (frame, c->clientMac, 6);
	memcpy (frame + 6, c->myMac, 6);
	frame[12] = (unsigned char) (ETH_P_CHAOS >> 8);
	frame[13] = (unsigned char) (ETH_P_CHAOS & 0xFF);

	ch[0] = 0;								/* Protocol/forwarding byte */
	ch[1] = opcode;
	mini_put16 (ch + 2, (unsigned short) (nBytes & 0xFFF));
	mini_put16 (ch + 4, c->clientAddr);
	mini_put16 (ch + 6, c->clientIndex);
	mini_put16 (ch + 8, c->myAddr);
	mini_put16 (ch + 10, c->myIndex);
	mini_put16 (ch + 12, num);
	mini_put16 (ch + 14, c->pktNumIn);		/* Acknowledge everything we've seen */
	if (nBytes > 0)
		memcpy (ch + MINI_CHAOS_HEADER, data, nBytes);

	frameBytes = MINI_ETH_HEADER + MINI_CHAOS_HEADER + nBytes;
	if (saveFrame != NULL)
	  {
		memcpy (saveFrame, frame, frameBytes);
		*saveBytes = frameBytes;
	  }
	MINI_TRACE ("tx op %#o num %d ack %d len %zu",
				opcode, num, c->pktNumIn, nBytes);
	(*c->emit) (c->emitCtx, frame, frameBytes);
}

/* Send a controlled (sequenced, acknowledged, retransmitted) packet */

static void mini_send_controlled (MiniCore* c, unsigned char opcode,
								  const unsigned char* data, size_t nBytes, uint64_t nowMs)
{
	c->pktNumOut = mini_inc16 (c->pktNumOut);
	mini_emit_chaos (c, opcode, c->pktNumOut, data, nBytes, c->outFrame, &c->outBytes);
	c->outstanding = TRUE;
	c->sentAtMs = nowMs;
	c->retries = 0;
}

static void mini_retransmit (MiniCore* c, uint64_t nowMs)
{
	MINI_TRACE ("retransmit (attempt %d)", c->retries + 1);
	(*c->emit) (c->emitCtx, c->outFrame, c->outBytes);
	c->sentAtMs = nowMs;
	c->retries++;
	c->nRetransmits++;
}


/*** Protocol actions ***/

static void mini_send_next_chunk (MiniCore* c, uint64_t nowMs)
{
  unsigned char data[MAX_CHAOS_DATA_BYTES];
  size_t nRead;

	nRead = fread (data, 1, sizeof (data), c->file);
	if (nRead > 0)
	  {
		if (c->binary && (nRead & 1))
		  {
			/* .vbins are 16-bit streams; an odd tail would mean a truncated
			   file.  Serve it padded rather than wedging the transfer. */
			MINI_WARN ("odd byte count in binary file -- padding");
			data[nRead++] = 0;
		  }
		mini_send_controlled (c, (unsigned char) (c->binary ? MINI_DAT_BINARY
														    : MINI_DAT_ASCII),
							  data, nRead, nowMs);
	  }
	else
	  {
		mini_send_controlled (c, CHAOS_OP_EOF, NULL, 0, nowMs);
		mini_close_file (c);
		c->xfer = XFER_EOF;
	  }
}

static void mini_open_request (MiniCore* c, const unsigned char* data, size_t nBytes,
							   boolean binary, uint64_t nowMs)
{
  char request[MAX_CHAOS_DATA_BYTES + 1];
  char path[1200];
  char truename[256];
  unsigned char answer[MAX_CHAOS_DATA_BYTES];
  size_t answerBytes, truenameBytes;
  unsigned long universalTime = 0;
  boolean won = FALSE;

	memcpy (request, data, nBytes);
	request[nBytes] = 0;

	mini_close_file (c);					/* Abandon any half-done transfer */

	if (!mini_translate (c, request, binary, path, sizeof (path),
						 truename, sizeof (truename)))
	  {
		snprintf (truename, sizeof (truename), "%s", request);
		MINI_WARN ("unparseable pathname \"%s\"", request);
	  }
	else
	  {
		c->file = fopen (path, "rb");
		if (c->file != NULL)
		  {
			struct stat st;
			if (0 == stat (path, &st))
				universalTime = (unsigned long) st.st_mtime + MINI_UT_UNIX_EPOCH;
			won = TRUE;
		  }
		else
			MINI_WARN ("open failed: %s", path);
	  }

	/* Answer: truename, CR, then the file date as four raw bytes of 32-bit
	   universal time (low 16-bit half first, each half low byte first) --
	   LMINI builds a bignum from exactly these four bytes. */
	truenameBytes = strlen (truename);
	if (truenameBytes > sizeof (answer) - 5)
		truenameBytes = sizeof (answer) - 5;
	memcpy (answer, truename, truenameBytes);
	answerBytes = truenameBytes;
	answer[answerBytes++] = 0x8D;			/* Lispm #\Return (0215) */
	answer[answerBytes++] = (unsigned char) (universalTime & 0xFF);
	answer[answerBytes++] = (unsigned char) ((universalTime >> 8) & 0xFF);
	answer[answerBytes++] = (unsigned char) ((universalTime >> 16) & 0xFF);
	answer[answerBytes++] = (unsigned char) ((universalTime >> 24) & 0xFF);

	if (won)
	  {
		c->binary = binary;
		c->xfer = XFER_DATA;
		c->nFilesServed++;
		printf ("mini: serving %s\n", path);
	  }
	else
		c->nFilesFailed++;

	mini_send_controlled (c, (unsigned char) (won ? MINI_ANS_WON : MINI_ANS_LOST),
						  answer, answerBytes, nowMs);
}


/*** Input dispatch ***/

static void mini_handle_arp (MiniCore* c, const unsigned char* frame, size_t nBytes)
{
  unsigned char reply[MINI_ETH_HEADER + 24];
  const unsigned char* arp = frame + MINI_ETH_HEADER;

	/* Payload: 8-byte arphdr, sender MAC+chaos (6+2), target MAC+chaos (6+2) */
	if (nBytes < MINI_ETH_HEADER + 24)
		return;
	/* arphdr fields are network order; chaos addresses little-endian */
	if (arp[0] != 0 || arp[1] != 1)			/* Hardware: Ethernet */
		return;
	if (arp[2] != 0x08 || arp[3] != 0x04)	/* Protocol: CHAOS */
		return;
	if (arp[4] != 6 || arp[5] != 2)			/* Address lengths */
		return;
	if (arp[6] != 0 || arp[7] != 1)			/* Opcode: request */
		return;
	if (mini_get16 (arp + 8 + 6 + 2 + 6) != c->myAddr)	/* Target chaos address */
		return;

	memcpy (reply, frame + 6, 6);			/* To the requester */
	memcpy (reply + 6, c->myMac, 6);
	reply[12] = (unsigned char) (ETH_P_ARP >> 8);
	reply[13] = (unsigned char) (ETH_P_ARP & 0xFF);
	memcpy (reply + MINI_ETH_HEADER, arp, 8);
	reply[MINI_ETH_HEADER + 7] = 2;			/* Opcode: reply */
	memcpy (reply + MINI_ETH_HEADER + 8, c->myMac, 6);			/* Sender: us */
	mini_put16 (reply + MINI_ETH_HEADER + 8 + 6, c->myAddr);
	memcpy (reply + MINI_ETH_HEADER + 8 + 8, arp + 8, 8);		/* Target: requester */

	MINI_TRACE ("ARP request for %#o -> reply", c->myAddr);
	(*c->emit) (c->emitCtx, reply, sizeof (reply));
}

static void mini_handle_rfc (MiniCore* c, const unsigned char* frame,
							 const unsigned char* ch, size_t dataBytes, uint64_t nowMs)
{
  unsigned short srcAddr = mini_get16 (ch + 8);
  unsigned short srcIndex = mini_get16 (ch + 10);
  unsigned short num = mini_get16 (ch + 12);

	if (dataBytes < 4 ||
		0 != memcmp (ch + MINI_CHAOS_HEADER, "MINI", 4))
	  {
		MINI_TRACE ("RFC for a contact other than MINI -- ignored");
		return;
	  }

	if (c->state == MINI_OPEN && srcIndex == c->clientIndex && num == c->rfcNum)
	  {
		/* Duplicate RFC: our OPN was lost; repeat it */
		MINI_TRACE ("duplicate RFC -> resend OPN");
		(*c->emit) (c->emitCtx, c->opnFrame, c->opnBytes);
		return;
	  }

	/* A new connection (possibly a client reboot) always wins */
	mini_close_file (c);
	memcpy (c->clientMac, frame + 6, 6);
	c->clientAddr = srcAddr;
	c->clientIndex = srcIndex;
	c->rfcNum = num;
	c->pktNumIn = num;
	c->myIndex = mini_inc16 (c->myIndex);
	if (0 == c->myIndex)
		c->myIndex = 1;
	c->pktNumOut = (unsigned short) (0x0100 + c->myIndex);	/* Arbitrary initial number */
	c->state = MINI_OPEN;
	MINI_TRACE ("RFC from %#o index %d -> OPN", srcAddr, srcIndex);
	mini_send_controlled (c, CHAOS_OP_OPN, NULL, 0, nowMs);
	memcpy (c->opnFrame, c->outFrame, c->outBytes);
	c->opnBytes = c->outBytes;
}

static void mini_handle_chaos (MiniCore* c, const unsigned char* frame, size_t nBytes,
							   uint64_t nowMs)
{
  const unsigned char* ch = frame + MINI_ETH_HEADER;
  unsigned char opcode;
  unsigned short dataBytes, srcIndex, num, ack;

	if (nBytes < MINI_ETH_HEADER + MINI_CHAOS_HEADER)
		return;
	opcode = ch[1];
	dataBytes = (unsigned short) (mini_get16 (ch + 2) & 0xFFF);
	srcIndex = mini_get16 (ch + 10);
	num = mini_get16 (ch + 12);
	ack = mini_get16 (ch + 14);
	if ((size_t) dataBytes > nBytes - MINI_ETH_HEADER - MINI_CHAOS_HEADER)
		return;								/* Malformed */

	MINI_TRACE ("rx op %#o num %d ack %d len %d", opcode, num, ack, dataBytes);

	if (CHAOS_OP_RFC == opcode)
	  {
		mini_handle_rfc (c, frame, ch, dataBytes, nowMs);
		return;
	  }

	if (c->state != MINI_OPEN || srcIndex != c->clientIndex)
		return;								/* Not our connection */
	memcpy (c->clientMac, frame + 6, 6);

	/* Every packet piggybacks an acknowledgement.  When it covers the
	   outstanding packet, the window opens and any transfer advances. */
	if (c->outstanding && mini_seq_geq (ack, c->pktNumOut))
	  {
		c->outstanding = FALSE;
		if (XFER_DATA == c->xfer)
			mini_send_next_chunk (c, nowMs);
		else if (XFER_EOF == c->xfer)
			c->xfer = XFER_NONE;			/* EOF acknowledged; await next request */
	  }

	switch (opcode)
	  {
	  case MINI_REQ_ASCII:
	  case MINI_REQ_BINARY:
		if (num == mini_inc16 (c->pktNumIn))
		  {
			c->pktNumIn = num;
			mini_open_request (c, ch + MINI_CHAOS_HEADER, dataBytes,
							   (boolean) (MINI_REQ_BINARY == opcode), nowMs);
		  }
		else if (num == c->pktNumIn && c->outstanding)
		  {
			/* The request we already answered, again: our answer was lost */
			MINI_TRACE ("duplicate request -> retransmit");
			mini_retransmit (c, nowMs);
		  }
		break;

	  case CHAOS_OP_STS:
		break;								/* Ack already processed above */

	  case CHAOS_OP_CLS:
	  case CHAOS_OP_LOS:
		MINI_TRACE ("connection closed by client (op %#o)", opcode);
		mini_close_file (c);
		c->state = MINI_IDLE;
		c->outstanding = FALSE;
		break;

	  default:
		break;								/* LMINI sends nothing else */
	  }
}

/* Feed one guest frame to the core */

static void mini_core_input (MiniCore* c, const unsigned char* frame, size_t nBytes,
							 uint64_t nowMs)
{
  unsigned short etherType;

	if (nBytes < MINI_ETH_HEADER)
		return;
	etherType = (unsigned short) ((frame[12] << 8) | frame[13]);
	if (ETH_P_ARP == etherType)
		mini_handle_arp (c, frame, nBytes);
	else if (ETH_P_CHAOS == etherType)
		mini_handle_chaos (c, frame, nBytes, nowMs);
}

/* Periodic retransmit check */

static void mini_core_tick (MiniCore* c, uint64_t nowMs)
{
	if (c->state != MINI_OPEN || !c->outstanding)
		return;
	if (nowMs - c->sentAtMs < MINI_RETRANSMIT_MS)
		return;
	if (c->retries >= MINI_MAX_RETRIES)
	  {
		static const char reason[] = "MINI server timed out awaiting your acknowledgement";
		MINI_WARN ("client stopped acknowledging -- closing the connection");
		mini_close_file (c);
		c->outstanding = FALSE;
		mini_emit_chaos (c, CHAOS_OP_LOS, mini_inc16 (c->pktNumOut),
						 (const unsigned char*) reason, sizeof (reason) - 1, NULL, NULL);
		c->state = MINI_IDLE;
		return;
	  }
	mini_retransmit (c, nowMs);
}

/* Does this guest frame belong to the MINI server?  (Cheap classification
   for the transmitter's fast path -- full validation happens in the core.) */

static boolean mini_frame_is_ours (const MiniCore* c, const unsigned char* frame,
								   size_t nBytes)
{
  unsigned short etherType;

	if (nBytes < MINI_ETH_HEADER + 4)
		return (FALSE);
	etherType = (unsigned short) ((frame[12] << 8) | frame[13]);
	if (ETH_P_ARP == etherType)
	  {
		/* ARP for the chaos protocol with our address as target. */
		if (nBytes < MINI_ETH_HEADER + 24)
			return (FALSE);
		if (frame[MINI_ETH_HEADER + 2] != 0x08 || frame[MINI_ETH_HEADER + 3] != 0x04)
			return (FALSE);
		return (mini_get16 (frame + MINI_ETH_HEADER + 8 + 6 + 2 + 6) == c->myAddr);
	  }
	if (ETH_P_CHAOS == etherType)
	  {
		if (nBytes < MINI_ETH_HEADER + MINI_CHAOS_HEADER)
			return (FALSE);
		return (mini_get16 (frame + MINI_ETH_HEADER + 4) == c->myAddr);
	  }
	return (FALSE);
}

#ifdef MINI_STANDALONE
#include <sys/stat.h>
#else

/*** Emulator glue: rings, server thread, injection ***/

#include <sys/stat.h>

#define MINI_RING_SLOTS 8

typedef struct
  {
	size_t nBytes;
	unsigned char data[MaxEmbNetPacketSize];
  }		MiniRingFrame;

typedef struct
  {
	boolean enabled;
	int debug;							/* MINI_DEBUG in the environment: trace frames */
	EmbNetChannel* channel;
	MiniCore core;

	/* Guest->server frames, filled by the transmitter thread */
	MiniRingFrame rxRing[MINI_RING_SLOTS];
	volatile unsigned rxHead, rxTail;		/* Pop at head, push at tail */
	pthread_mutex_t rxLock;
	pthread_cond_t rxWake;

	/* Server->guest frames, drained by the receiver thread */
	MiniRingFrame txRing[MINI_RING_SLOTS];
	volatile unsigned txHead, txTail;
	pthread_mutex_t txLock;

	pthread_t thread;
	boolean threadSetup;
	volatile int stop;
  }		MiniServer;

static MiniServer miniServer;				/* Singleton; zero = disabled */


static uint64_t MiniServerNowMs (void)
{
  struct timespec ts;

	clock_gettime (CLOCK_MONOTONIC, &ts);
	return ((uint64_t) ts.tv_sec * 1000 + (uint64_t) (ts.tv_nsec / 1000000L));
}

/* Runtime frame tracing (set MINI_DEBUG in the environment): every chaos and
   ARP frame crossing the server, hex-dumped to stderr */

static void MiniServerDumpFrame (const char* tag, const unsigned char* frame,
								 size_t nBytes)
{
  size_t i, n = (nBytes < 64) ? nBytes : 64;

	fprintf (stderr, "mini %s %zu bytes:", tag, nBytes);
	for (i = 0; i < n; i++)
	  {
		if (0 == (i % 16))
			fprintf (stderr, "\n   ");
		fprintf (stderr, " %02x", frame[i]);
	  }
	fputc ('\n', stderr);
}

/* Emit callback: queue the reply frame and wake the receiver thread */

static void MiniServerEmit (void* ctx, const unsigned char* frame, size_t nBytes)
{
  MiniServer* server = (MiniServer*) ctx;
  unsigned next;

	if (nBytes > MaxEmbNetPacketSize)
		return;
	if (server->debug)
		MiniServerDumpFrame ("tx->guest", frame, nBytes);
	pthread_mutex_lock (&server->txLock);
	next = (server->txTail + 1) % MINI_RING_SLOTS;
	if (next == server->txHead)
	  {
		pthread_mutex_unlock (&server->txLock);
		MINI_WARN ("injection ring full -- reply dropped (client will retry)");
		return;
	  }
	server->txRing[server->txTail].nBytes = nBytes;
	memcpy (server->txRing[server->txTail].data, frame, nBytes);
	server->txTail = next;
	pthread_mutex_unlock (&server->txLock);

	/* Wake the receiver thread so the reply is delivered immediately rather
	   than on its next 250 ms timeout */
	if (server->channel->vmnetSem != NULL)
		dispatch_semaphore_signal ((dispatch_semaphore_t) server->channel->vmnetSem);
}

static void MiniServerThread (pthread_addr_t argument)
{
  MiniServer* server = (MiniServer*) argument;
  MiniRingFrame frame;

	WaitUntilInitializationComplete ();

	while (!server->stop)
	  {
		boolean haveFrame = FALSE;

		pthread_mutex_lock (&server->rxLock);
		if (server->rxHead == server->rxTail)
		  {
			struct timespec deadline;
			clock_gettime (CLOCK_REALTIME, &deadline);
			deadline.tv_nsec += 100000000L;			/* 100 ms tick */
			if (deadline.tv_nsec >= 1000000000L)
			  {
				deadline.tv_sec++;
				deadline.tv_nsec -= 1000000000L;
			  }
			pthread_cond_timedwait (&server->rxWake, &server->rxLock, &deadline);
		  }
		if (server->rxHead != server->rxTail)
		  {
			frame = server->rxRing[server->rxHead];
			server->rxHead = (server->rxHead + 1) % MINI_RING_SLOTS;
			haveFrame = TRUE;
		  }
		pthread_mutex_unlock (&server->rxLock);

		if (haveFrame)
			mini_core_input (&server->core, frame.data, frame.nBytes, MiniServerNowMs ());
		else
			mini_core_tick (&server->core, MiniServerNowMs ());
	  }

	mini_close_file (&server->core);
}


boolean MiniServerStart (EmbNetChannel* channel, unsigned short serverAddr,
						 unsigned short guestAddr, const char* root)
{
  MiniServer* server = &miniServer;

	if (server->enabled)
	  {
		vwarn ("mini", "server already running -- only one channel may carry it");
		return (FALSE);
	  }

	server->channel = channel;
	server->debug = (getenv ("MINI_DEBUG") != NULL);
	mini_core_init (&server->core, serverAddr, guestAddr, root,
					&MiniServerEmit, (void*) server);
	server->rxHead = server->rxTail = 0;
	server->txHead = server->txTail = 0;
	server->stop = 0;
	if (pthread_mutex_init (&server->rxLock, NULL) ||
		pthread_mutex_init (&server->txLock, NULL) ||
		pthread_cond_init (&server->rxWake, NULL))
	  {
		vwarn ("mini", "unable to create server locks -- MINI server disabled");
		return (FALSE);
	  }
	if (pthread_create (&server->thread, &EmbCommAreaPtr->inputThreadAttrs,
						(pthread_startroutine_t) &MiniServerThread, (pthread_addr_t) server))
	  {
		vwarn ("mini", "unable to create server thread -- MINI server disabled");
		return (FALSE);
	  }
	server->threadSetup = TRUE;
	server->enabled = TRUE;

	printf ("net #%d MINI server: chaos %o serving %s\n",
			(int) channel->unit, (unsigned) serverAddr, root);
	return (TRUE);
}

void MiniServerStop (void)
{
  MiniServer* server = &miniServer;
  void* exitValue;

	if (!server->enabled)
		return;
	server->enabled = FALSE;
	server->stop = 1;
	pthread_mutex_lock (&server->rxLock);
	pthread_cond_signal (&server->rxWake);
	pthread_mutex_unlock (&server->rxLock);
	if (server->threadSetup)
	  {
		pthread_join (server->thread, &exitValue);
		server->threadSetup = FALSE;
	  }
}

boolean MiniServerInterceptFrame (EmbNetChannel* channel,
								  const unsigned char* frame, size_t nBytes)
{
  MiniServer* server = &miniServer;
  unsigned next;

	if (!server->enabled || server->channel != channel)
		return (FALSE);
	if (server->debug && nBytes >= MINI_ETH_HEADER)
	  {
		unsigned short etherType = (unsigned short) ((frame[12] << 8) | frame[13]);
		if (ETH_P_ARP == etherType || ETH_P_CHAOS == etherType)
			MiniServerDumpFrame (mini_frame_is_ours (&server->core, frame, nBytes)
									 ? "rx<-guest (ours)" : "rx<-guest (not ours)",
								 frame, nBytes);
	  }
	if (!mini_frame_is_ours (&server->core, frame, nBytes))
		return (FALSE);

	pthread_mutex_lock (&server->rxLock);
	next = (server->rxTail + 1) % MINI_RING_SLOTS;
	if (next == server->rxHead)
	  {
		/* Ring full; drop -- LMINI retransmits everything that matters */
		pthread_mutex_unlock (&server->rxLock);
		return (TRUE);
	  }
	server->rxRing[server->rxTail].nBytes = nBytes;
	memcpy (server->rxRing[server->rxTail].data, frame, nBytes);
	server->rxTail = next;
	pthread_cond_signal (&server->rxWake);
	pthread_mutex_unlock (&server->rxLock);
	return (TRUE);
}

boolean MiniServerTakeInjectedFrame (EmbNetChannel* channel,
									 unsigned char* buf, size_t bufSize, size_t* nBytes)
{
  MiniServer* server = &miniServer;
  boolean haveFrame = FALSE;

	if (!server->enabled || server->channel != channel)
		return (FALSE);

	pthread_mutex_lock (&server->txLock);
	if (server->txHead != server->txTail)
	  {
		MiniRingFrame* frame = &server->txRing[server->txHead];
		if (frame->nBytes <= bufSize)
		  {
			memcpy (buf, frame->data, frame->nBytes);
			*nBytes = frame->nBytes;
			haveFrame = TRUE;
		  }
		server->txHead = (server->txHead + 1) % MINI_RING_SLOTS;
	  }
	pthread_mutex_unlock (&server->txLock);
	return (haveFrame);
}

#endif /* !MINI_STANDALONE */
