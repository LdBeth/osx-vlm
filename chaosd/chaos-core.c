/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd protocol core: chaos-ARP, a small Chaos NCP, and the connection
 * table.  See chaos-core.h for the wire format.  Pure: no I/O besides the
 * emit callback and the -d trace on stderr.
 *
 * The NCP mirrors the Genera 9.0 one (SYS:NETWORK;CHAOS-NCP) wherever the
 * peer can see the difference:
 *   - RFC, OPN, EOF and DAT (opcode >= 0200) are controlled: numbered,
 *     queued until receipted, retransmitted.  Everything else is sent once.
 *   - Every outgoing packet's ack# is readNum (what our user has consumed).
 *   - STS and SNS carry packet# 0; STS data is (receipt, window).
 *   - An incoming ack# implies receipt; STS/OPN may carry a higher receipt.
 *   - Packets numbered at or below receivedNum are duplicates and packets
 *     beyond readNum + window are over-window: both are answered with STS.
 *   - SNS is answered with STS; a duplicate OPN is answered with STS.
 *   - Packets for a connection we don't have draw LOS, except the replies
 *     (ANS, CLS, FWD, LOS) which are dropped.
 *   - Incoming RFC "STATUS" is answered with ANS (host name, 32 bytes,
 *     zero padded -- the CHAOS-STATUS server's format); any other contact
 *     is refused with CLS.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "chaos-core.h"


/*** Utilities ***/

unsigned short chaos_get16 (const unsigned char* p)
{
	return ((unsigned short) (p[0] | (p[1] << 8)));
}

void chaos_put16 (unsigned char* p, unsigned short v)
{
	p[0] = (unsigned char) (v & 0xFF);
	p[1] = (unsigned char) (v >> 8);
}

/* a < b in 16-bit sequence space (Genera's PKTNUM-<) */
boolean chaos_seq_lt (unsigned short a, unsigned short b)
{
	return ((((unsigned short) (a - b)) & 0x8000) != 0);
}

static unsigned short seq_diff (unsigned short a, unsigned short b)
{
	return ((unsigned short) (a - b));
}

static unsigned short seq_inc (unsigned short a)
{
	return ((unsigned short) (a + 1));
}

const char* chaos_opcode_name (unsigned char opcode)
{
  static const char* names[] =
	{ "?00", "RFC", "OPN", "CLS", "FWD", "ANS", "SNS", "STS",
	  "RUT", "LOS", "LSN", "MNT", "EOF", "UNC", "BRD" };

	if (opcode >= CHOP_DAT)
		return ((opcode >= 0300) ? "DWD" : "DAT");
	if (opcode < sizeof (names) / sizeof (names[0]))
		return (names[opcode]);
	return ("???");
}

void chaos_trace_frame (const char* tag, const unsigned char* frame, size_t nBytes)
{
  unsigned short etherType;

	if (nBytes < CHAOS_ETH_HEADER)
		return;
	etherType = (unsigned short) ((frame[12] << 8) | frame[13]);
	fprintf (stderr, "chaosd: %s %02x:%02x:%02x:%02x:%02x:%02x > %02x:%02x:%02x:%02x:%02x:%02x ",
			 tag, frame[6], frame[7], frame[8], frame[9], frame[10], frame[11],
			 frame[0], frame[1], frame[2], frame[3], frame[4], frame[5]);
	if (CHAOS_ETHERTYPE == etherType && nBytes >= CHAOS_ETH_HEADER + CHAOS_HEADER)
	  {
		const unsigned char* ch = frame + CHAOS_ETH_HEADER;
		unsigned short n = (unsigned short) (chaos_get16 (ch + 2) & 0xFFF);
		size_t i, shown;
		fprintf (stderr, "%s(%03o) %o/%u <- %o/%u num %u ack %u len %u",
				 chaos_opcode_name (ch[1]), ch[1],
				 chaos_get16 (ch + 4), chaos_get16 (ch + 6),
				 chaos_get16 (ch + 8), chaos_get16 (ch + 10),
				 chaos_get16 (ch + 12), chaos_get16 (ch + 14), n);
		if (n > nBytes - CHAOS_ETH_HEADER - CHAOS_HEADER)
			n = (unsigned short) (nBytes - CHAOS_ETH_HEADER - CHAOS_HEADER);
		shown = (n < 32) ? n : 32;
		if (shown > 0)
		  {
			fputs (" \"", stderr);
			for (i = 0; i < shown; i++)
			  {
				unsigned char b = ch[CHAOS_HEADER + i];
				if (b >= 0x20 && b < 0x7F && b != '"' && b != '\\')
					fputc (b, stderr);
				else
					fprintf (stderr, "\\%03o", b);
			  }
			fputs ((shown < n) ? "\"..." : "\"", stderr);
		  }
		fputc ('\n', stderr);
	  }
	else if (ARP_ETHERTYPE == etherType && nBytes >= CHAOS_ARP_FRAME)
	  {
		const unsigned char* a = frame + CHAOS_ETH_HEADER;
		if (a[2] == 0x08 && a[3] == 0x04)
			fprintf (stderr, "chaos-ARP %s %o is %02x:%02x:%02x:%02x:%02x:%02x, for %o\n",
					 (a[7] == 1) ? "request" : (a[7] == 2) ? "reply" : "op?",
					 chaos_get16 (a + 14),
					 a[8], a[9], a[10], a[11], a[12], a[13],
					 chaos_get16 (a + 22));
		else
			fprintf (stderr, "ARP (not chaos)\n");
	  }
	else
		fprintf (stderr, "ethertype %04x, %zu bytes\n", etherType, nBytes);
}

static void emit_frame (ChaosCore* c, const unsigned char* frame, size_t nBytes)
{
	c->nFramesOut++;
	if (c->debug)
		chaos_trace_frame ("tx", frame, nBytes);
	(*c->emit) (c->emitCtx, frame, nBytes);
}


/*** ARP ***/

static ChaosArpEntry* arp_find (ChaosCore* c, unsigned short addr, boolean create)
{
  int i, victim = 0;
  uint64_t oldest = UINT64_MAX;

	for (i = 0; i < CHAOS_ARP_ENTRIES; i++)
		if ((c->arp[i].valid || c->arp[i].requested) && c->arp[i].addr == addr)
			return (&c->arp[i]);
	if (!create)
		return (NULL);
	for (i = 0; i < CHAOS_ARP_ENTRIES; i++)
	  {
		if (!c->arp[i].valid && !c->arp[i].requested)
		  {
			victim = i;
			break;
		  }
		if (c->arp[i].learnedMs < oldest)
		  {
			oldest = c->arp[i].learnedMs;
			victim = i;
		  }
	  }
	memset (&c->arp[victim], 0, sizeof (ChaosArpEntry));
	c->arp[victim].addr = addr;
	return (&c->arp[victim]);
}

static void arp_send_request (ChaosCore* c, ChaosArpEntry* e, uint64_t nowMs)
{
  unsigned char f[CHAOS_ARP_FRAME];
  unsigned char* a = f + CHAOS_ETH_HEADER;

	memset (f, 0xFF, 6);
	memcpy (f + 6, c->myMac, 6);
	f[12] = (unsigned char) (ARP_ETHERTYPE >> 8);
	f[13] = (unsigned char) (ARP_ETHERTYPE & 0xFF);
	a[0] = 0; a[1] = 1;						/* Hardware: Ethernet */
	a[2] = 0x08; a[3] = 0x04;				/* Protocol: CHAOS */
	a[4] = 6; a[5] = 2;
	a[6] = 0; a[7] = 1;						/* Request */
	memcpy (a + 8, c->myMac, 6);
	chaos_put16 (a + 14, c->myAddr);
	memset (a + 16, 0, 6);
	chaos_put16 (a + 22, e->addr);
	e->requested = TRUE;
	e->requestedMs = nowMs;
	emit_frame (c, f, sizeof (f));
}

/* Retransmit everything unreceipted now: the peer just became reachable */
static void conn_retransmit (ChaosCore* c, ChaosConn* k, uint64_t nowMs, uint64_t minAgeMs);

static void arp_learn (ChaosCore* c, unsigned short addr, const unsigned char mac[6],
					   uint64_t nowMs)
{
  ChaosArpEntry* e;
  boolean wasValid;
  int i;

	if (0 == addr || addr == c->myAddr)
		return;
	e = arp_find (c, addr, TRUE);
	wasValid = e->valid && 0 == memcmp (e->mac, mac, 6);
	memcpy (e->mac, mac, 6);
	e->valid = TRUE;
	e->requested = FALSE;
	e->learnedMs = nowMs;
	if (wasValid)
		return;
	if (c->debug)
		fprintf (stderr, "chaosd: learned %o is %02x:%02x:%02x:%02x:%02x:%02x\n", addr,
				 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
	/* Frames we dropped for want of this MAC go out now, not at the next
	   retransmission tick */
	for (i = 0; i < CHAOS_MAX_CONNS; i++)
	  {
		ChaosConn* k = &c->conns[i];
		if ((CONN_RFC_SENT == k->state || CONN_OPEN == k->state) && k->remoteAddr == addr)
			conn_retransmit (c, k, nowMs, 0);
	  }
}

boolean chaos_arp_lookup (ChaosCore* c, unsigned short addr, unsigned char mac[6])
{
  ChaosArpEntry* e = arp_find (c, addr, FALSE);

	if (NULL == e || !e->valid)
		return (FALSE);
	memcpy (mac, e->mac, 6);
	return (TRUE);
}

/* Resolve for transmission.  Unknown: send (rate-limited) ARP and fail --
   the caller drops the frame and controlled packets get retransmitted once
   the reply arrives.  Old: use it, but refresh in the background. */
static boolean arp_resolve (ChaosCore* c, unsigned short addr, unsigned char mac[6],
							uint64_t nowMs)
{
  ChaosArpEntry* e = arp_find (c, addr, TRUE);

	if (e->valid)
	  {
		memcpy (mac, e->mac, 6);
		if (nowMs - e->learnedMs > CHAOS_ARP_REFRESH_MS &&
			(!e->requested || nowMs - e->requestedMs >= CHAOS_ARP_RETRY_MS * 20))
			arp_send_request (c, e, nowMs);
		return (TRUE);
	  }
	if (!e->requested || nowMs - e->requestedMs >= CHAOS_ARP_RETRY_MS)
		arp_send_request (c, e, nowMs);
	return (FALSE);
}

static void handle_arp (ChaosCore* c, const unsigned char* frame, size_t nBytes,
						uint64_t nowMs)
{
  const unsigned char* a = frame + CHAOS_ETH_HEADER;
  unsigned char reply[CHAOS_ARP_FRAME];
  unsigned char* r = reply + CHAOS_ETH_HEADER;
  unsigned short spa, tpa;

	if (nBytes < CHAOS_ARP_FRAME)
		return;
	if (a[0] != 0 || a[1] != 1 || a[2] != 0x08 || a[3] != 0x04 || a[4] != 6 || a[5] != 2)
		return;								/* Not chaos-over-Ethernet ARP */
	spa = chaos_get16 (a + 14);
	tpa = chaos_get16 (a + 22);
	arp_learn (c, spa, a + 8, nowMs);		/* Requests and replies both teach */
	if (a[6] != 0 || a[7] != 1 || tpa != c->myAddr)
		return;

	memcpy (reply, a + 8, 6);				/* To the requester */
	memcpy (reply + 6, c->myMac, 6);
	reply[12] = (unsigned char) (ARP_ETHERTYPE >> 8);
	reply[13] = (unsigned char) (ARP_ETHERTYPE & 0xFF);
	memcpy (r, a, 6);
	r[6] = 0; r[7] = 2;						/* Reply */
	memcpy (r + 8, c->myMac, 6);
	chaos_put16 (r + 14, c->myAddr);
	memcpy (r + 16, a + 8, 6);
	chaos_put16 (r + 22, spa);
	emit_frame (c, reply, sizeof (reply));
}


/*** Chaos packet transmission ***/

/* Build and send one chaos packet.  Returns FALSE if the destination's
   MAC is not yet known (the frame is dropped; an ARP request is out). */
static boolean send_raw (ChaosCore* c, unsigned char opcode,
						 unsigned short destAddr, unsigned short destIndex,
						 unsigned short srcIndex, unsigned short num, unsigned short ack,
						 const unsigned char* data, size_t nBytes, uint64_t nowMs)
{
  unsigned char frame[CHAOS_MAX_FRAME];
  unsigned char* ch = frame + CHAOS_ETH_HEADER;

	if (nBytes > CHAOS_MAX_DATA)
		nBytes = CHAOS_MAX_DATA;
	if (!arp_resolve (c, destAddr, frame, nowMs))
		return (FALSE);
	memcpy (frame + 6, c->myMac, 6);
	frame[12] = (unsigned char) (CHAOS_ETHERTYPE >> 8);
	frame[13] = (unsigned char) (CHAOS_ETHERTYPE & 0xFF);
	ch[0] = 0;
	ch[1] = opcode;
	chaos_put16 (ch + 2, (unsigned short) (nBytes & 0xFFF));
	chaos_put16 (ch + 4, destAddr);
	chaos_put16 (ch + 6, destIndex);
	chaos_put16 (ch + 8, c->myAddr);
	chaos_put16 (ch + 10, srcIndex);
	chaos_put16 (ch + 12, num);
	chaos_put16 (ch + 14, ack);
	if (nBytes > 0)
		memcpy (ch + CHAOS_HEADER, data, nBytes);
	emit_frame (c, frame, CHAOS_ETH_HEADER + CHAOS_HEADER + nBytes);
	return (TRUE);
}

/* Uncontrolled packet on a connection; piggybacks our ack */
static void conn_send_unc (ChaosCore* c, ChaosConn* k, unsigned char opcode,
						   unsigned short num, const unsigned char* data, size_t nBytes,
						   uint64_t nowMs)
{
	k->lastAckSent = k->readNum;
	k->ackDueMs = 0;
	send_raw (c, opcode, k->remoteAddr, k->remoteIndex, k->localIndex,
			  num, k->readNum, data, nBytes, nowMs);
}

static void conn_send_sts (ChaosCore* c, ChaosConn* k, uint64_t nowMs)
{
  unsigned char d[4];

	chaos_put16 (d, k->receivedNum);
	chaos_put16 (d + 2, k->localWindow);
	conn_send_unc (c, k, CHOP_STS, 0, d, 4, nowMs);
}

static void conn_transmit (ChaosCore* c, ChaosConn* k, ChaosPkt* p, uint64_t nowMs)
{
	p->sentAtMs = nowMs;
	k->lastAckSent = k->readNum;
	k->ackDueMs = 0;
	send_raw (c, p->opcode, k->remoteAddr,
			  (CHOP_RFC == p->opcode) ? 0 : k->remoteIndex,
			  k->localIndex, p->num,
			  (CHOP_RFC == p->opcode) ? 0 : k->readNum,
			  p->data, p->nBytes, nowMs);
}

static void conn_send_controlled (ChaosCore* c, ChaosConn* k, unsigned char opcode,
								  const unsigned char* data, size_t nBytes, uint64_t nowMs)
{
  ChaosPkt* p;

	k->sentNum = seq_inc (k->sentNum);
	p = &k->sendq[k->sentNum & (CHAOS_RING - 1)];
	p->present = TRUE;
	p->opcode = opcode;
	p->num = k->sentNum;
	p->nBytes = (unsigned short) nBytes;
	p->offset = 0;
	if (nBytes > 0)
		memcpy (p->data, data, nBytes);
	conn_transmit (c, k, p, nowMs);
}

static void conn_retransmit (ChaosCore* c, ChaosConn* k, uint64_t nowMs, uint64_t minAgeMs)
{
  unsigned short n;

	for (n = seq_inc (k->receiptNum); !chaos_seq_lt (k->sentNum, n); n = seq_inc (n))
	  {
		ChaosPkt* p = &k->sendq[n & (CHAOS_RING - 1)];
		if (!p->present || p->num != n)
			continue;
		if (nowMs - p->sentAtMs < minAgeMs)
			continue;
		c->nRetransmits++;
		conn_transmit (c, k, p, nowMs);
	  }
}

static void conn_set_closed (ChaosConn* k, ChaosCloseKind kind,
							 const unsigned char* text, size_t nBytes)
{
  int i;

	k->state = CONN_CLOSED;
	k->closeKind = kind;
	if (nBytes > CHAOS_MAX_DATA)
		nBytes = CHAOS_MAX_DATA;
	memcpy (k->reason, text, nBytes);
	k->reason[nBytes] = 0;
	k->reasonBytes = nBytes;
	for (i = 0; i < CHAOS_RING; i++)
		k->sendq[i].present = FALSE;
	k->receiptNum = k->ackedNum = k->sentNum;
	k->ackDueMs = 0;
}

/* Send our CLS and close: the normal end of a connection we finished */
static void conn_close_cls (ChaosCore* c, ChaosConn* k, const char* reason,
							ChaosCloseKind kind, uint64_t nowMs)
{
	conn_send_unc (c, k, CHOP_CLS, 0, (const unsigned char*) reason, strlen (reason), nowMs);
	conn_set_closed (k, kind, (const unsigned char*) reason, strlen (reason));
}

static int conn_window_available (ChaosConn* k)
{
	return ((int) k->remoteWindow - (int) seq_diff (k->sentNum, k->ackedNum));
}

/* If the user has asked to finish and the window allows, send EOF */
static void conn_maybe_send_eof (ChaosCore* c, ChaosConn* k, uint64_t nowMs)
{
	if (CONN_OPEN == k->state && k->eofWanted && !k->eofSent &&
		conn_window_available (k) > 0)
	  {
		conn_send_controlled (c, k, CHOP_EOF, NULL, 0, nowMs);
		k->eofSent = TRUE;
		k->eofNum = k->sentNum;
	  }
}

/* Genera's PROCESS-ACK: ack implies receipt; out-of-range values ignored */
static void conn_process_ack (ChaosCore* c, ChaosConn* k, unsigned short ack,
							  unsigned short receipt, uint64_t nowMs)
{
  unsigned short n;

	if (chaos_seq_lt (k->sentNum, ack) || chaos_seq_lt (k->sentNum, receipt))
		return;
	if (chaos_seq_lt (receipt, ack))
		receipt = ack;
	if (chaos_seq_lt (k->receiptNum, receipt))
	  {
		for (n = seq_inc (k->receiptNum); !chaos_seq_lt (receipt, n); n = seq_inc (n))
			k->sendq[n & (CHAOS_RING - 1)].present = FALSE;
		k->receiptNum = receipt;
	  }
	if (chaos_seq_lt (k->ackedNum, ack))
		k->ackedNum = ack;

	if (k->eofSent && !chaos_seq_lt (k->ackedNum, k->eofNum) && CONN_OPEN == k->state)
		conn_close_cls (c, k, "Finished", CLOSE_DONE, nowMs);
	else
		conn_maybe_send_eof (c, k, nowMs);
}


/*** Connection table ***/

static ChaosConn* conn_for_handle (ChaosCore* c, int h)
{
	if (h < 0 || h >= CHAOS_MAX_CONNS || CONN_FREE == c->conns[h].state)
		return (NULL);
	return (&c->conns[h]);
}

ChaosConn* chaos_conn (ChaosCore* c, int h)
{
	return (conn_for_handle (c, h));
}

ChaosConnState chaos_state (ChaosCore* c, int h)
{
  ChaosConn* k = conn_for_handle (c, h);

	return ((NULL == k) ? CONN_FREE : k->state);
}

void chaos_core_init (ChaosCore* c, unsigned short myAddr, const unsigned char myMac[6],
					  const char* hostName, ChaosEmitFn emit, void* emitCtx)
{
	memset (c, 0, sizeof (ChaosCore));
	c->myAddr = myAddr;
	memcpy (c->myMac, myMac, 6);
	strncpy (c->hostName, hostName, sizeof (c->hostName) - 1);
	c->localWindow = CHAOS_DEFAULT_WINDOW;
	c->initialPktNum = 0x0100;
	c->uniquizer = 1;
	c->emit = emit;
	c->emitCtx = emitCtx;
}

int chaos_open (ChaosCore* c, unsigned short addr, const char* contact, size_t contactBytes,
				uint64_t nowMs)
{
  ChaosConn* k;
  int h;

	if (0 == contactBytes || contactBytes > CHAOS_MAX_DATA)
		return (-1);
	for (h = 0; h < CHAOS_MAX_CONNS; h++)
		if (CONN_FREE == c->conns[h].state)
			break;
	if (h == CHAOS_MAX_CONNS)
		return (-1);
	k = &c->conns[h];
	memset (k, 0, sizeof (ChaosConn));

	/* Index: slot in the low bits, a uniquizer above; never zero */
	k->localIndex = (unsigned short) ((c->uniquizer << 5) | h);
	c->uniquizer = (unsigned short) ((c->uniquizer + 1) & 0x7FF);
	if (0 == c->uniquizer)
		c->uniquizer = 1;

	k->state = CONN_RFC_SENT;
	k->remoteAddr = addr;
	k->remoteIndex = 0;
	k->localWindow = c->localWindow;
	k->remoteWindow = 1;					/* Only the RFC until OPN says more */
	k->sentNum = (unsigned short) (c->initialPktNum - 1);
	k->ackedNum = k->receiptNum = k->sentNum;
	c->initialPktNum = (unsigned short) (c->initialPktNum + 0x0100);
	k->openedMs = k->lastHeardMs = k->lastProbeMs = nowMs;
	conn_send_controlled (c, k, CHOP_RFC, (const unsigned char*) contact, contactBytes, nowMs);
	return (h);
}

size_t chaos_send_room (ChaosCore* c, int h)
{
  ChaosConn* k = conn_for_handle (c, h);
  int avail;

	if (NULL == k || k->state != CONN_OPEN || k->eofWanted)
		return (0);
	avail = conn_window_available (k);
	return ((avail > 0) ? (size_t) avail * CHAOS_MAX_DATA : 0);
}

size_t chaos_send (ChaosCore* c, int h, const unsigned char* data, size_t nBytes,
				   uint64_t nowMs)
{
  ChaosConn* k = conn_for_handle (c, h);
  size_t sent = 0;

	if (NULL == k || k->state != CONN_OPEN || k->eofWanted)
		return (0);
	while (sent < nBytes && conn_window_available (k) > 0)
	  {
		size_t n = nBytes - sent;
		if (n > CHAOS_MAX_DATA)
			n = CHAOS_MAX_DATA;
		conn_send_controlled (c, k, CHOP_DAT, data + sent, n, nowMs);
		sent += n;
	  }
	return (sent);
}

void chaos_finish (ChaosCore* c, int h, uint64_t nowMs)
{
  ChaosConn* k = conn_for_handle (c, h);

	if (NULL == k || k->state != CONN_OPEN || k->eofWanted)
		return;
	k->eofWanted = TRUE;
	k->finishStartMs = nowMs;
	conn_maybe_send_eof (c, k, nowMs);
}

boolean chaos_recv_ready (ChaosCore* c, int h)
{
  ChaosConn* k = conn_for_handle (c, h);

	return (NULL != k && k->readNum != k->receivedNum && !k->eofReceived);
}

boolean chaos_recv_eof (ChaosCore* c, int h)
{
  ChaosConn* k = conn_for_handle (c, h);

	return (NULL != k && k->eofReceived);
}

size_t chaos_recv (ChaosCore* c, int h, unsigned char* buf, size_t max, uint64_t nowMs)
{
  ChaosConn* k = conn_for_handle (c, h);
  size_t got = 0;
  boolean advanced = FALSE;

	if (NULL == k)
		return (0);
	while (got < max && k->readNum != k->receivedNum && !k->eofReceived)
	  {
		unsigned short n = seq_inc (k->readNum);
		ChaosPkt* p = &k->rcvq[n & (CHAOS_RING - 1)];
		if (CHOP_EOF == p->opcode)
			k->eofReceived = TRUE;
		else
		  {
			size_t take = (size_t) (p->nBytes - p->offset);
			if (take > max - got)
				take = max - got;
			memcpy (buf + got, p->data + p->offset, take);
			got += take;
			p->offset = (unsigned short) (p->offset + take);
			if (p->offset < p->nBytes)
				break;
		  }
		p->present = FALSE;
		k->readNum = n;
		advanced = TRUE;
	  }

	/* Tell the peer its window reopened: at once when half of it has been
	   consumed, else shortly (or piggybacked on our next packet) */
	if (advanced && CONN_OPEN == k->state)
	  {
		if (seq_diff (k->readNum, k->lastAckSent) >= (k->localWindow + 1) / 2 ||
			k->eofReceived)
			conn_send_sts (c, k, nowMs);
		else if (0 == k->ackDueMs)
			k->ackDueMs = nowMs + CHAOS_ACK_DELAY_MS;
	  }
	return (got);
}

void chaos_release (ChaosCore* c, int h, const char* reason, uint64_t nowMs)
{
  ChaosConn* k = conn_for_handle (c, h);

	if (NULL == k)
		return;
	if (CONN_OPEN == k->state)
		conn_send_unc (c, k, CHOP_CLS, 0, (const unsigned char*) reason,
					   strlen (reason), nowMs);
	memset (k, 0, sizeof (ChaosConn));
	k->state = CONN_FREE;
}


/*** Input ***/

/* Queue a DAT/EOF in order (Genera's QUEUE-ORDERED-INPUT-PKT) */
static void conn_queue_input (ChaosCore* c, ChaosConn* k, const unsigned char* ch,
							  unsigned short dataBytes, uint64_t nowMs)
{
  unsigned short num = chaos_get16 (ch + 12);
  ChaosPkt* p;

	if (!chaos_seq_lt (k->receivedNum, num))
	  {
		c->nDuplicates++;
		conn_send_sts (c, k, nowMs);		/* Our receipt must have been lost */
		return;
	  }
	if (seq_diff (num, k->readNum) > k->localWindow)
	  {
		c->nOverWindow++;
		conn_send_sts (c, k, nowMs);
		return;
	  }
	p = &k->rcvq[num & (CHAOS_RING - 1)];
	if (p->present && p->num == num)
	  {
		c->nDuplicates++;
		conn_send_sts (c, k, nowMs);
		return;
	  }
	p->present = TRUE;
	p->num = num;
	p->opcode = ch[1];
	p->nBytes = dataBytes;
	p->offset = 0;
	memcpy (p->data, ch + CHAOS_HEADER, dataBytes);

	/* Advance the in-order mark over anything now contiguous */
	for (;;)
	  {
		unsigned short next = seq_inc (k->receivedNum);
		ChaosPkt* q = &k->rcvq[next & (CHAOS_RING - 1)];
		if (!q->present || q->num != next)
			break;
		k->receivedNum = next;
		if (CHOP_EOF == q->opcode)
			break;
	  }
	/* An out-of-order arrival means something was lost: say what we have */
	if (num != k->receivedNum && chaos_seq_lt (k->receivedNum, num))
		conn_send_sts (c, k, nowMs);
}

static void handle_rfc (ChaosCore* c, const unsigned char* ch, unsigned short dataBytes,
						uint64_t nowMs)
{
  unsigned short srcAddr = chaos_get16 (ch + 8);
  unsigned short srcIndex = chaos_get16 (ch + 10);
  unsigned short num = chaos_get16 (ch + 12);
  const unsigned char* data = ch + CHAOS_HEADER;
  size_t contactBytes = 0;
  char contact[CHAOS_MAX_DATA + 1];

	while (contactBytes < dataBytes && data[contactBytes] != ' ')
		contactBytes++;
	memcpy (contact, data, contactBytes);
	contact[contactBytes] = 0;

	if (0 == strcasecmp (contact, "STATUS"))
	  {
		unsigned char ans[32];
		size_t n = strlen (c->hostName);
		memset (ans, 0, sizeof (ans));
		memcpy (ans, c->hostName, (n > 32) ? 32 : n);
		c->nStatusAnswered++;
		send_raw (c, CHOP_ANS, srcAddr, srcIndex, 0, 0, num, ans, sizeof (ans), nowMs);
	  }
	else
	  {
		char reason[CHAOS_MAX_DATA + 64];
		int n = snprintf (reason, sizeof (reason), "No server for contact name %s",
						  contact);
		c->nRfcRefused++;
		send_raw (c, CHOP_CLS, srcAddr, srcIndex, 0, 0, num,
				  (const unsigned char*) reason, (size_t) n, nowMs);
	  }
}

static void send_los_reply (ChaosCore* c, const unsigned char* ch, const char* reason,
							uint64_t nowMs)
{
	c->nLosSent++;
	send_raw (c, CHOP_LOS, chaos_get16 (ch + 8), chaos_get16 (ch + 10),
			  chaos_get16 (ch + 6), 0, 0,
			  (const unsigned char*) reason, strlen (reason), nowMs);
}

static void handle_chaos (ChaosCore* c, const unsigned char* frame, size_t nBytes,
						  uint64_t nowMs)
{
  const unsigned char* ch = frame + CHAOS_ETH_HEADER;
  unsigned char opcode;
  unsigned short dataBytes, destAddr, destIndex, srcAddr, srcIndex, num, ack;
  ChaosConn* k;

	if (nBytes < CHAOS_ETH_HEADER + CHAOS_HEADER)
		return;
	opcode = ch[1];
	dataBytes = (unsigned short) (chaos_get16 (ch + 2) & 0xFFF);
	destAddr = chaos_get16 (ch + 4);
	destIndex = chaos_get16 (ch + 6);
	srcAddr = chaos_get16 (ch + 8);
	srcIndex = chaos_get16 (ch + 10);
	num = chaos_get16 (ch + 12);
	ack = chaos_get16 (ch + 14);
	if (dataBytes > CHAOS_MAX_DATA ||
		(size_t) dataBytes > nBytes - CHAOS_ETH_HEADER - CHAOS_HEADER)
		return;								/* Malformed */

	/* A directly connected sender (same subnet) teaches us its MAC */
	if ((srcAddr >> 8) == (c->myAddr >> 8) && !(frame[6] & 1))
		arp_learn (c, srcAddr, frame + 6, nowMs);

	if (destAddr != c->myAddr)
		return;								/* Not for us (we don't forward) */

	switch (opcode)
	  {
	  case CHOP_RFC:
		handle_rfc (c, ch, dataBytes, nowMs);
		return;
	  case CHOP_BRD: case CHOP_RUT: case CHOP_MNT: case CHOP_LSN:
		return;
	  default:
		break;
	  }

	k = &c->conns[destIndex & (CHAOS_MAX_CONNS - 1)];
	if (CONN_FREE == k->state || k->localIndex != destIndex || k->remoteAddr != srcAddr ||
		(CONN_RFC_SENT != k->state && k->remoteIndex != srcIndex))
	  {
		if (CHOP_ANS == opcode || CHOP_CLS == opcode || CHOP_FWD == opcode ||
			CHOP_LOS == opcode)
			return;
		send_los_reply (c, ch, "No such connection", nowMs);
		return;
	  }
	k->lastHeardMs = nowMs;

	if (CONN_RFC_SENT == k->state)
	  {
		switch (opcode)
		  {
		  case CHOP_OPN:
			if (dataBytes < 4)
				return;
			k->remoteIndex = srcIndex;
			k->readNum = k->receivedNum = k->lastAckSent = num;
			k->remoteWindow = chaos_get16 (ch + CHAOS_HEADER + 2);
			if (k->remoteWindow > CHAOS_MAX_WINDOW)
				k->remoteWindow = CHAOS_MAX_WINDOW;
			k->state = CONN_OPEN;
			conn_process_ack (c, k, ack, chaos_get16 (ch + CHAOS_HEADER), nowMs);
			conn_send_sts (c, k, nowMs);
			return;
		  case CHOP_CLS:
			conn_set_closed (k, CLOSE_CLS, ch + CHAOS_HEADER, dataBytes);
			return;
		  case CHOP_LOS:
			conn_set_closed (k, CLOSE_LOS, ch + CHAOS_HEADER, dataBytes);
			return;
		  case CHOP_ANS:
			conn_set_closed (k, CLOSE_ANS, ch + CHAOS_HEADER, dataBytes);
			return;
		  case CHOP_FWD:
			{
			  char text[80];
			  int n = snprintf (text, sizeof (text),
								"Forwarded to host %o (forwarding is not supported)", ack);
				conn_set_closed (k, CLOSE_LOS, (const unsigned char*) text, (size_t) n);
			}
			return;
		  default:
			return;							/* STS etc. before our OPN: ignore */
		  }
	  }

	if (CONN_CLOSED == k->state)
	  {
		if (CHOP_ANS == opcode || CHOP_CLS == opcode || CHOP_FWD == opcode ||
			CHOP_LOS == opcode || CHOP_STS == opcode)
			return;
		send_los_reply (c, ch, "Connection in invalid state", nowMs);
		return;
	  }

	/* CONN_OPEN */
	if (opcode >= CHOP_DAT || CHOP_EOF == opcode)
	  {
		conn_process_ack (c, k, ack, ack, nowMs);
		if (CONN_OPEN == k->state)
			conn_queue_input (c, k, ch, dataBytes, nowMs);
		return;
	  }
	switch (opcode)
	  {
	  case CHOP_STS:
		if (dataBytes < 4)
			return;
		{
		  unsigned short w = chaos_get16 (ch + CHAOS_HEADER + 2);
			if (w > CHAOS_MAX_WINDOW)
				w = CHAOS_MAX_WINDOW;
			k->remoteWindow = w;
		}
		conn_process_ack (c, k, ack, chaos_get16 (ch + CHAOS_HEADER), nowMs);
		/* Whatever the receipt doesn't cover is probably lost */
		if (CONN_OPEN == k->state)
			conn_retransmit (c, k, nowMs, CHAOS_STS_RETRANSMIT_MS);
		return;
	  case CHOP_SNS:
		conn_process_ack (c, k, ack, ack, nowMs);
		if (CONN_OPEN == k->state)
			conn_send_sts (c, k, nowMs);
		return;
	  case CHOP_OPN:
		conn_send_sts (c, k, nowMs);			/* Our STS was lost */
		return;
	  case CHOP_CLS:
		conn_set_closed (k, CLOSE_CLS, ch + CHAOS_HEADER, dataBytes);
		return;
	  case CHOP_LOS:
		conn_set_closed (k, CLOSE_LOS, ch + CHAOS_HEADER, dataBytes);
		return;
	  default:
		return;								/* UNC, ANS, FWD on an open conn */
	  }
}

void chaos_core_input (ChaosCore* c, const unsigned char* frame, size_t nBytes,
					   uint64_t nowMs)
{
  unsigned short etherType;

	if (nBytes < CHAOS_ETH_HEADER)
		return;
	etherType = (unsigned short) ((frame[12] << 8) | frame[13]);
	if (etherType != CHAOS_ETHERTYPE && etherType != ARP_ETHERTYPE)
		return;
	if (0 == memcmp (frame + 6, c->myMac, 6))
		return;								/* Our own broadcast, echoed */
	c->nFramesIn++;
	if (c->debug)
		chaos_trace_frame ("rx", frame, nBytes);
	if (ARP_ETHERTYPE == etherType)
		handle_arp (c, frame, nBytes, nowMs);
	else
		handle_chaos (c, frame, nBytes, nowMs);
}


/*** Timers ***/

void chaos_core_tick (ChaosCore* c, uint64_t nowMs)
{
  int h;

	for (h = 0; h < CHAOS_MAX_CONNS; h++)
	  {
		ChaosConn* k = &c->conns[h];
		uint64_t heard;

		if (CONN_RFC_SENT == k->state)
		  {
			if (nowMs - k->openedMs >= CHAOS_RFC_TIMEOUT_MS)
			  {
				static const char why[] = "Host not responding";
				conn_set_closed (k, CLOSE_TIMEOUT, (const unsigned char*) why, sizeof (why) - 1);
			  }
			else
				conn_retransmit (c, k, nowMs, CHAOS_RETRANSMIT_MS);
			continue;
		  }
		if (k->state != CONN_OPEN)
			continue;

		heard = nowMs - k->lastHeardMs;
		if (heard >= CHAOS_HOST_DOWN_MS)
		  {
			static const char why[] = "Host stopped responding";
			conn_set_closed (k, CLOSE_TIMEOUT, (const unsigned char*) why, sizeof (why) - 1);
			continue;
		  }
		if (k->eofWanted && nowMs - k->finishStartMs >= CHAOS_FINISH_TIMEOUT_MS)
		  {
			conn_close_cls (c, k, "Finished (EOF not acknowledged)", CLOSE_DONE, nowMs);
			continue;
		  }

		conn_retransmit (c, k, nowMs, CHAOS_RETRANSMIT_MS);

		if (k->ackDueMs != 0 && nowMs >= k->ackDueMs)
			conn_send_sts (c, k, nowMs);

		/* Genera's PROBE-CONN: SNS when waiting for acks, when the peer's
		   window is shut, or when it has been quiet a long time */
		if (nowMs - k->lastProbeMs >= CHAOS_PROBE_MS)
		  {
			k->lastProbeMs = nowMs;
			if (k->ackedNum != k->sentNum || 0 == k->remoteWindow ||
				heard >= CHAOS_LONELY_MS)
				conn_send_unc (c, k, CHOP_SNS, 0, NULL, 0, nowMs);
		  }
	  }
}

int chaos_core_next_timeout (ChaosCore* c, uint64_t nowMs, int maxMs)
{
  int h;
  int best = maxMs;

	for (h = 0; h < CHAOS_MAX_CONNS; h++)
	  {
		ChaosConn* k = &c->conns[h];
		if (CONN_OPEN == k->state && k->ackDueMs != 0)
		  {
			int t = (k->ackDueMs > nowMs) ? (int) (k->ackDueMs - nowMs) : 0;
			if (t < best)
				best = t;
		  }
	  }
	return (best);
}
