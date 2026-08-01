/* -*- Mode: C; Tab-Width: 4 -*- */

/* Standalone harness for the MINI server protocol core.
 *
 * Not part of the emulator build.  Compile and run with:
 *
 *   cc -DMINI_STANDALONE -o /tmp/mini-test \
 *      life-support/mini-server-test.c && /tmp/mini-test
 *
 * (mini-server.c is #included below so the core's statics are reachable.)
 *
 * The frames fed in replay LMINI's transmit path byte for byte: ARP
 * resolution, RFC "MINI LISPM ", duplicate RFC, binary and character file
 * requests with lazy STS acks, duplicate requests, a nonexistent file,
 * a second file on the same connection, retransmit-on-timeout, and a
 * mid-transfer reconnect.  Fixture files are created under mkdtemp.
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <assert.h>
#include <sys/stat.h>

#include "mini-server.c"

#define CLIENT_ADDR 0402
#define SERVER_ADDR 0401

static unsigned char clientMac[6] = { 0x02, 0x42, 0x23, 0x42, 0x00, 0x00 };

/* Captured server output */
#define MAX_EMITTED 64
static struct { unsigned char frame[MINI_MAX_FRAME]; size_t nBytes; } emitted[MAX_EMITTED];
static int nEmitted;

static void captureEmit (void* ctx, const unsigned char* frame, size_t nBytes)
{
	(void) ctx;
	assert (nEmitted < MAX_EMITTED);
	memcpy (emitted[nEmitted].frame, frame, nBytes);
	emitted[nEmitted].nBytes = nBytes;
	nEmitted++;
}

static int failures;

#define CHECK(cond, what)												\
	do {																\
		if (!(cond)) {													\
			printf ("FAIL: %s (line %d): %s\n", what, __LINE__, #cond);	\
			failures++;													\
		} else															\
			printf ("ok:   %s\n", what);								\
	} while (0)

/* Client-side frame builders, mirroring LMINI's mini-transmit-packet */

static uint64_t now;					/* Fake clock, milliseconds */
static unsigned short clientNumOut;		/* mini-packet-number-out */
static unsigned short clientNumIn;		/* mini-packet-number-in */
static unsigned short clientIndex = 0x1234;
static unsigned short serverIndex;

static void sendChaos (MiniCore* c, unsigned char opcode,
					   const unsigned char* data, size_t nBytes)
{
  unsigned char frame[MINI_MAX_FRAME];
  unsigned char* ch = frame + MINI_ETH_HEADER;

	memset (frame, 0, sizeof (frame));
	memset (frame, 0xFF, 6);				/* Guest broadcasts before ARP resolution */
	memcpy (frame + 6, clientMac, 6);
	frame[12] = 0x08; frame[13] = 0x04;
	ch[0] = 0;
	ch[1] = opcode;
	mini_put16 (ch + 2, (unsigned short) nBytes);
	mini_put16 (ch + 4, SERVER_ADDR);
	mini_put16 (ch + 6, serverIndex);		/* mini-remote-index (0 before OPN) */
	mini_put16 (ch + 8, CLIENT_ADDR);
	mini_put16 (ch + 10, clientIndex);
	mini_put16 (ch + 12, clientNumOut);
	mini_put16 (ch + 14, clientNumIn);
	if (nBytes > 0)
		memcpy (ch + MINI_CHAOS_HEADER, data, nBytes);
	mini_core_input (c, frame, MINI_ETH_HEADER + MINI_CHAOS_HEADER + nBytes, now);
}

static void sendSTS (MiniCore* c)
{
  unsigned char data[4];

	mini_put16 (data, clientNumIn);			/* Receipt */
	mini_put16 (data + 2, 1);				/* Window size */
	sendChaos (c, CHAOS_OP_STS, data, 4);
}

static void sendRFC (MiniCore* c)
{
	sendChaos (c, CHAOS_OP_RFC, (const unsigned char*) "MINI LISPM ", 11);
}

static void sendRequest (MiniCore* c, const char* name, int binary)
{
	sendChaos (c, (unsigned char) (binary ? MINI_REQ_BINARY : MINI_REQ_ASCII),
			   (const unsigned char*) name, strlen (name));
}

/* Accessors on captured frames */

static unsigned char frOp (int i)	  { return emitted[i].frame[MINI_ETH_HEADER + 1]; }
static unsigned short frLen (int i)	  { return (unsigned short) (mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 2) & 0xFFF); }
static unsigned short frDest (int i)  { return mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 4); }
static unsigned short frDIdx (int i)  { return mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 6); }
static unsigned short frSIdx (int i)  { return mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 10); }
static unsigned short frNum (int i)	  { return mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 12); }
static unsigned short frAck (int i)	  { return mini_get16 (emitted[i].frame + MINI_ETH_HEADER + 14); }
static const unsigned char* frData (int i) { return emitted[i].frame + MINI_ETH_HEADER + MINI_CHAOS_HEADER; }

/* Consume the most recent emitted frame as the client would: record the
   server's packet number and index, and prepare the ack */

static void clientConsume (int i)
{
	serverIndex = frSIdx (i);
	clientNumIn = frNum (i);
}

/* Transfer a whole file, mimicking mini-get-data-packet's lazy acks.
   Returns the byte count; fills sink (must be large enough). */

static size_t transferFile (MiniCore* c, unsigned char* sink, unsigned char expectOp)
{
  size_t total = 0;

	for (;;)
	  {
		nEmitted = 0;
		sendSTS (c);						/* Ack previous, open the window */
		assert (nEmitted == 1);
		if (frOp (0) == CHAOS_OP_EOF)
		  {
			clientConsume (0);
			nEmitted = 0;
			sendSTS (c);					/* Ack the EOF */
			assert (nEmitted == 0);			/* Which provokes nothing further */
			return (total);
		  }
		assert (frOp (0) == expectOp);
		assert (frNum (0) == mini_inc16 (clientNumIn));
		memcpy (sink + total, frData (0), frLen (0));
		total += frLen (0);
		clientConsume (0);
	  }
}

int main (void)
{
  MiniCore core;
  char root[] = "/tmp/mini-test-XXXXXX";
  char scratch[4096];
  static unsigned char binContent[100000];
  static unsigned char sink[sizeof (binContent) + MAX_CHAOS_DATA_BYTES];
  const char asciiContent[] = ";;; -*- Mode: LISP -*-\215(defun foo () 42)\215";
  size_t i, n;
  int f;

	/* Fixtures */
	assert (mkdtemp (root) != NULL);
	snprintf (scratch, sizeof (scratch), "%s/sys", root);
	assert (0 == mkdir (scratch, 0755));
	snprintf (scratch, sizeof (scratch), "%s/sys/mini-alists.vbin", root);
	for (i = 0; i < sizeof (binContent); i++)
		binContent[i] = (unsigned char) (i * 7 + (i >> 8));
	{
	  FILE* out = fopen (scratch, "wb");
		assert (out != NULL);
		assert (fwrite (binContent, 1, sizeof (binContent), out) == sizeof (binContent));
		fclose (out);
	}
	snprintf (scratch, sizeof (scratch), "%s/io/rest.lisp", root);
	snprintf (scratch, sizeof (scratch), "%s/io", root);
	assert (0 == mkdir (scratch, 0755));
	snprintf (scratch, sizeof (scratch), "%s/io/rest.lisp", root);
	{
	  FILE* out = fopen (scratch, "w");
		assert (out != NULL);
		fputs (asciiContent, out);
		fclose (out);
	}

	mini_core_init (&core, SERVER_ADDR, CLIENT_ADDR, root, &captureEmit, NULL);

	/* --- ARP resolution --- */
	{
	  unsigned char arp[MINI_ETH_HEADER + 24];
		memset (arp, 0xFF, 6);
		memcpy (arp + 6, clientMac, 6);
		arp[12] = 0x08; arp[13] = 0x06;
		arp[14] = 0x00; arp[15] = 0x01;		/* Ethernet */
		arp[16] = 0x08; arp[17] = 0x04;		/* CHAOS */
		arp[18] = 6; arp[19] = 2;
		arp[20] = 0x00; arp[21] = 0x01;		/* Request */
		memcpy (arp + 22, clientMac, 6);
		mini_put16 (arp + 28, CLIENT_ADDR);
		memset (arp + 30, 0, 6);
		mini_put16 (arp + 36, SERVER_ADDR);

		CHECK (mini_frame_is_ours (&core, arp, sizeof (arp)), "ARP classified as ours");
		mini_core_input (&core, arp, sizeof (arp), now);
		CHECK (nEmitted == 1, "ARP produced one reply");
		CHECK (emitted[0].frame[12] == 0x08 && emitted[0].frame[13] == 0x06,
			   "ARP reply ethertype");
		CHECK (emitted[0].frame[MINI_ETH_HEADER + 7] == 2, "ARP reply opcode");
		CHECK (mini_get16 (emitted[0].frame + MINI_ETH_HEADER + 8 + 6) == SERVER_ADDR,
			   "ARP reply sender chaos address");
		CHECK (0 == memcmp (emitted[0].frame, clientMac, 6), "ARP reply to requester MAC");
		CHECK (mini_get16 (emitted[0].frame + MINI_ETH_HEADER + 8 + 8 + 6) == CLIENT_ADDR,
			   "ARP reply target chaos address");

		/* An ARP request for someone else must pass through untouched */
		mini_put16 (arp + 36, 0777);
		CHECK (!mini_frame_is_ours (&core, arp, sizeof (arp)),
			   "foreign ARP not intercepted");
	}

	/* --- Connection --- */
	clientNumOut = 1;						/* RFC is client packet #1 */
	clientNumIn = 0;
	nEmitted = 0;
	sendRFC (&core);
	CHECK (nEmitted == 1 && frOp (0) == CHAOS_OP_OPN, "RFC answered with OPN");
	CHECK (frDest (0) == CLIENT_ADDR && frDIdx (0) == clientIndex, "OPN addressed to client");
	CHECK (frAck (0) == 1, "OPN acks the RFC");

	/* Duplicate RFC (OPN lost): same index, same number */
	sendRFC (&core);
	CHECK (nEmitted == 2 && frOp (1) == CHAOS_OP_OPN && frNum (1) == frNum (0) &&
		   frSIdx (1) == frSIdx (0),
		   "duplicate RFC re-answered with the same OPN");

	clientConsume (1);
	clientNumOut = mini_inc16 (clientNumOut);	/* wait-for-open: incf out */
	nEmitted = 0;
	sendSTS (&core);
	CHECK (nEmitted == 0, "STS after OPN produces nothing (no transfer yet)");

	/* --- Binary file --- */
	sendRequest (&core, "SYS:SYS;MINI-ALISTS.VBIN.NEWEST", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_WON, "binary open answered 0202");
	CHECK (frNum (0) == mini_inc16 (clientNumIn), "0202 sequenced after OPN");
	{
	  const unsigned char* d = frData (0);
	  unsigned short len = frLen (0);
	  const unsigned char* cr = memchr (d, 0x8D, len);
		CHECK (cr != NULL && (cr - d) + 5 == len, "0202 = truename + CR + 4 date bytes");
		CHECK (0 == memcmp (d, "SYS: SYS; MINI-ALISTS.VBIN.1", 28), "truename form");
		{
		  struct stat st;
		  unsigned long ut;
			snprintf (scratch, sizeof (scratch), "%s/sys/mini-alists.vbin", root);
			assert (0 == stat (scratch, &st));
			ut = (unsigned long) cr[1] | ((unsigned long) cr[2] << 8) |
				 ((unsigned long) cr[3] << 16) | ((unsigned long) cr[4] << 24);
			CHECK (ut == (unsigned long) st.st_mtime + MINI_UT_UNIX_EPOCH,
				   "date is 32-bit universal time");
		}
	}

	/* Duplicate request (0202 lost): resend */
	n = (size_t) nEmitted;
	sendRequest (&core, "SYS:SYS;MINI-ALISTS.VBIN.NEWEST", 1);
	CHECK ((size_t) nEmitted == n + 1 && frOp (nEmitted - 1) == MINI_ANS_WON &&
		   frNum (nEmitted - 1) == frNum (0),
		   "duplicate request retransmits the 0202");

	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);	/* Client consumed the 0202 */
	nEmitted = 0;
	n = transferFile (&core, sink, MINI_DAT_BINARY);
	CHECK (n == sizeof (binContent), "binary transfer length");
	CHECK (0 == memcmp (sink, binContent, sizeof (binContent)), "binary transfer content");

	/* --- Retransmission on timeout --- */
	nEmitted = 0;
	sendRequest (&core, "SYS:IO;REST.LISP.NEWEST", 0);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_WON, "character open answered 0202");
	now += MINI_RETRANSMIT_MS + 50;
	mini_core_tick (&core, now);
	CHECK (nEmitted == 2 && frOp (1) == MINI_ANS_WON && frNum (1) == frNum (0),
		   "unacked 0202 retransmitted after timeout");

	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	nEmitted = 0;
	n = transferFile (&core, sink, MINI_DAT_ASCII);
	CHECK (n == strlen (asciiContent), "character transfer length");
	CHECK (0 == memcmp (sink, asciiContent, n), "character transfer content (verbatim)");

	/* --- Nonexistent file --- */
	nEmitted = 0;
	sendRequest (&core, "SYS:SYS;NO-SUCH-FILE.VBIN.NEWEST", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_LOST, "missing file answered 0203");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	sendSTS (&core);

	/* --- Escape attempts --- */
	nEmitted = 0;
	sendRequest (&core, "SYS:..;PASSWD.VBIN", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_LOST, "dot-dot component refused");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	sendSTS (&core);
	nEmitted = 0;
	sendRequest (&core, "HOST:SYS;FILE.VBIN", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_LOST, "non-SYS host refused");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	sendSTS (&core);

	/* --- Spaced pathname form --- */
	nEmitted = 0;
	sendRequest (&core, "SYS: SYS; MINI-ALISTS.VBIN.NEWEST", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_WON, "spaced pathname accepted");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	nEmitted = 0;
	n = transferFile (&core, sink, MINI_DAT_BINARY);
	CHECK (n == sizeof (binContent), "second binary transfer on same connection");

	/* --- Reconnect mid-transfer (client rebooted) --- */
	nEmitted = 0;
	sendRequest (&core, "SYS:SYS;MINI-ALISTS.VBIN.NEWEST", 1);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_WON, "open before reconnect");
	clientIndex = 0x4321;					/* New connection attempt */
	clientNumOut = 1;
	clientNumIn = 0;
	serverIndex = 0;
	nEmitted = 0;
	sendRFC (&core);
	CHECK (nEmitted == 1 && frOp (0) == CHAOS_OP_OPN, "mid-transfer RFC gets fresh OPN");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	sendSTS (&core);
	nEmitted = 0;
	sendRequest (&core, "SYS:IO;REST.LISP.NEWEST", 0);
	CHECK (nEmitted == 1 && frOp (0) == MINI_ANS_WON, "fresh connection serves again");
	clientConsume (0);
	clientNumOut = mini_inc16 (clientNumOut);
	nEmitted = 0;
	n = transferFile (&core, sink, MINI_DAT_ASCII);
	CHECK (n == strlen (asciiContent), "transfer on fresh connection");

	/* --- Chaos frame classification --- */
	{
	  unsigned char frame[MINI_ETH_HEADER + MINI_CHAOS_HEADER];
		memset (frame, 0, sizeof (frame));
		frame[12] = 0x08; frame[13] = 0x04;
		mini_put16 (frame + MINI_ETH_HEADER + 4, SERVER_ADDR);
		CHECK (mini_frame_is_ours (&core, frame, sizeof (frame)), "chaos to 0401 is ours");
		mini_put16 (frame + MINI_ETH_HEADER + 4, 0777);
		CHECK (!mini_frame_is_ours (&core, frame, sizeof (frame)),
			   "chaos to another host is not");
		frame[12] = 0x08; frame[13] = 0x00;
		CHECK (!mini_frame_is_ours (&core, frame, sizeof (frame)), "IP is not ours");
	}

	/* --- Coexist mode: sharing the address with a real NFILE host --- */
	{
	  unsigned char frame[MINI_ETH_HEADER + MINI_CHAOS_HEADER + 8];
	  unsigned char arp[MINI_ETH_HEADER + 24];

		core.coexist = TRUE;

		/* Chaos-ARP for our address passes through (the real host answers) */
		memset (arp, 0xFF, 6);
		memcpy (arp + 6, clientMac, 6);
		arp[12] = 0x08; arp[13] = 0x06;
		arp[14] = 0x00; arp[15] = 0x01;
		arp[16] = 0x08; arp[17] = 0x04;
		arp[18] = 6; arp[19] = 2;
		arp[20] = 0x00; arp[21] = 0x01;
		memcpy (arp + 22, clientMac, 6);
		mini_put16 (arp + 28, CLIENT_ADDR);
		memset (arp + 30, 0, 6);
		mini_put16 (arp + 36, SERVER_ADDR);
		CHECK (!mini_frame_is_ours (&core, arp, sizeof (arp)),
			   "coexist: ARP passes to the wire");

		/* An RFC for NFILE at our address passes through */
		memset (frame, 0, sizeof (frame));
		frame[12] = 0x08; frame[13] = 0x04;
		frame[MINI_ETH_HEADER + 1] = CHAOS_OP_RFC;
		mini_put16 (frame + MINI_ETH_HEADER + 2, 5);
		mini_put16 (frame + MINI_ETH_HEADER + 4, SERVER_ADDR);
		mini_put16 (frame + MINI_ETH_HEADER + 8, CLIENT_ADDR);
		mini_put16 (frame + MINI_ETH_HEADER + 10, 0x7777);
		memcpy (frame + MINI_ETH_HEADER + MINI_CHAOS_HEADER, "NFILE", 5);
		CHECK (!mini_frame_is_ours (&core, frame, sizeof (frame)),
			   "coexist: NFILE RFC passes to the wire");

		/* An RFC for MINI is still ours */
		memcpy (frame + MINI_ETH_HEADER + MINI_CHAOS_HEADER, "MINI ", 5);
		CHECK (mini_frame_is_ours (&core, frame, sizeof (frame)),
			   "coexist: MINI RFC is ours");

		/* Traffic on the open MINI conversation is ours... */
		frame[MINI_ETH_HEADER + 1] = CHAOS_OP_STS;
		mini_put16 (frame + MINI_ETH_HEADER + 10, clientIndex);
		CHECK (mini_frame_is_ours (&core, frame, sizeof (frame)),
			   "coexist: open-conversation traffic is ours");

		/* ...but the same opcode from another connection passes through */
		mini_put16 (frame + MINI_ETH_HEADER + 10, 0x7777);
		CHECK (!mini_frame_is_ours (&core, frame, sizeof (frame)),
			   "coexist: other-connection traffic passes to the wire");

		core.coexist = FALSE;
	}

	f = failures;
	printf (f ? "\n%d FAILURE(S)\n" : "\nall tests passed\n", f);
	return (f ? 1 : 0);
}
