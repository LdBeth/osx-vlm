/* -*- Mode: C; Tab-Width: 4 -*- */

/* Unit tests for chaosd: the protocol core, the stream front end and the
 * vmnet network identifier.  No vmnet, no root.
 *
 * Two kinds of peer stand in for Genera:
 *   - hand-built frames (peer_send) for exact wire checks, and
 *   - an automatic peer (peer.autoMode) running a minimal NCP: answers
 *     ARP, OPNs an RFC, receipts and acks every in-order packet, and can
 *     send a data stream respecting chaosd's window.
 * Time is a fake millisecond clock.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <poll.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>

#include "chaos-core.h"
#include "chaos-stream.h"
#include "netid.h"

static int failures, checks;

#define CHECK(cond, what)												\
	do {																\
		checks++;														\
		if (!(cond)) {													\
			printf ("FAIL: %s (line %d): %s\n", what, __LINE__, #cond);	\
			failures++;													\
		}																\
	} while (0)

static uint64_t now = 1000;
static uint64_t fake_clock (void) { return (now); }

#define CORE_ADDR 0402
#define PEER_ADDR 0401
static const unsigned char coreMac[6] = { 0x02, 0x43, 0x48, 0x41, 0x4F, 0x53 };
static const unsigned char peerMac[6] = { 0x0e, 0x06, 0x2d, 0xeb, 0xea, 0xe4 };

/* The live capture: Genera (#o401) asking who has #o402 */
static const unsigned char capturedArp[] =
  {
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0e, 0x06, 0x2d, 0xeb, 0xea, 0xe4,
	0x08, 0x06, 0x00, 0x01, 0x08, 0x04, 0x06, 0x02, 0x00, 0x01,
	0x0e, 0x06, 0x2d, 0xeb, 0xea, 0xe4, 0x01, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01
  };


/*** Core output capture ***/

#define MAX_FRAMES 4096
typedef struct { unsigned char f[CHAOS_MAX_FRAME]; size_t n; } Frame;
static Frame coreOut[MAX_FRAMES];
static int nCoreOut, coreOutRead;
static int dropToPeer;						/* Drop this many next core frames */

static void capture (void* ctx, const unsigned char* frame, size_t nBytes)
{
	(void) ctx;
	if (nCoreOut >= MAX_FRAMES)
	  {
		printf ("FAIL: capture overflow\n");
		failures++;
		return;
	  }
	memcpy (coreOut[nCoreOut].f, frame, nBytes);
	coreOut[nCoreOut].n = nBytes;
	nCoreOut++;
}

static void reset_capture (void) { nCoreOut = coreOutRead = 0; }

static unsigned char f_op (Frame* f) { return (f->f[15]); }
static unsigned short f_len (Frame* f) { return ((unsigned short) (chaos_get16 (f->f + 16) & 0xFFF)); }
static unsigned short f_dest (Frame* f) { return (chaos_get16 (f->f + 18)); }
static unsigned short f_didx (Frame* f) { return (chaos_get16 (f->f + 20)); }
static unsigned short f_src (Frame* f) { return (chaos_get16 (f->f + 22)); }
static unsigned short f_sidx (Frame* f) { return (chaos_get16 (f->f + 24)); }
static unsigned short f_num (Frame* f) { return (chaos_get16 (f->f + 26)); }
static unsigned short f_ack (Frame* f) { return (chaos_get16 (f->f + 28)); }
static unsigned char* f_data (Frame* f) { return (f->f + 30); }
static int f_is_chaos (Frame* f) { return (f->n >= 30 && f->f[12] == 0x08 && f->f[13] == 0x04); }

/* Count core frames with this opcode since index `from` */
static int count_op (int from, unsigned char op)
{
  int i, n = 0;

	for (i = from; i < nCoreOut; i++)
		if (f_is_chaos (&coreOut[i]) && f_op (&coreOut[i]) == op)
			n++;
	return (n);
}

static Frame* last_op (unsigned char op)
{
  int i;

	for (i = nCoreOut - 1; i >= 0; i--)
		if (f_is_chaos (&coreOut[i]) && f_op (&coreOut[i]) == op)
			return (&coreOut[i]);
	return (NULL);
}


/*** The peer ***/

typedef struct
  {
	ChaosCore* core;
	unsigned short index;					/* Peer's own connection index */
	unsigned short coreIndex;				/* chaosd's index for the connection */
	unsigned short sentNum, coreAcked, readNum, receivedNum;
	unsigned short window;					/* Advertised to chaosd */
	unsigned short coreWindow;				/* chaosd's advertised window */
	int autoMode;
	int opened, gotCls, gotLos;
	unsigned char rx[1 << 17];
	size_t rxLen;
	int rxEof;
	unsigned char tx[1 << 17];				/* Pending peer -> chaosd stream */
	size_t txLen, txOff;
	int txEof, txEofSent;
	int nOpnSent;
  }		Peer;

static Peer peer;

static void peer_reset (ChaosCore* core, unsigned short window)
{
	memset (&peer, 0, sizeof (peer));
	peer.core = core;
	peer.index = 0x4321;
	peer.window = window;
	peer.coreWindow = CHAOS_DEFAULT_WINDOW;
	peer.sentNum = 0x7000;
}

static void peer_send_raw (unsigned char op, unsigned short destIndex, unsigned short srcIndex,
						   unsigned short num, unsigned short ack,
						   const void* data, size_t n)
{
  unsigned char f[CHAOS_MAX_FRAME];

	memset (f, 0, sizeof (f));
	memcpy (f, coreMac, 6);
	memcpy (f + 6, peerMac, 6);
	f[12] = 0x08; f[13] = 0x04;
	f[15] = op;
	chaos_put16 (f + 16, (unsigned short) n);
	chaos_put16 (f + 18, CORE_ADDR);
	chaos_put16 (f + 20, destIndex);
	chaos_put16 (f + 22, PEER_ADDR);
	chaos_put16 (f + 24, srcIndex);
	chaos_put16 (f + 26, num);
	chaos_put16 (f + 28, ack);
	if (n > 0)
		memcpy (f + 30, data, n);
	chaos_core_input (peer.core, f, 30 + n, now);
}

/* On the established connection */
static void peer_send (unsigned char op, unsigned short num, const void* data, size_t n)
{
	peer_send_raw (op, peer.coreIndex, peer.index, num, peer.readNum, data, n);
}

static void peer_send_sts (void)
{
  unsigned char d[4];

	chaos_put16 (d, peer.receivedNum);
	chaos_put16 (d + 2, peer.window);
	peer_send (CHOP_STS, 0, d, 4);
}

static void peer_send_arp_reply (void)
{
  unsigned char f[60];

	memset (f, 0, sizeof (f));
	memcpy (f, coreMac, 6);
	memcpy (f + 6, peerMac, 6);
	f[12] = 0x08; f[13] = 0x06;
	f[14] = 0; f[15] = 1; f[16] = 0x08; f[17] = 0x04; f[18] = 6; f[19] = 2;
	f[20] = 0; f[21] = 2;
	memcpy (f + 22, peerMac, 6);
	chaos_put16 (f + 28, PEER_ADDR);
	memcpy (f + 30, coreMac, 6);
	chaos_put16 (f + 36, CORE_ADDR);
	chaos_core_input (peer.core, f, sizeof (f), now);
}

/* Push pending peer stream data within chaosd's window */
static void peer_push (void)
{
	if (!peer.opened || peer.gotCls)
		return;
	while ((unsigned short) (peer.sentNum - peer.coreAcked) < peer.coreWindow)
	  {
		size_t n = peer.txLen - peer.txOff;
		if (n > 0)
		  {
			if (n > CHAOS_MAX_DATA)
				n = CHAOS_MAX_DATA;
			peer.sentNum++;
			peer_send (CHOP_DAT, peer.sentNum, peer.tx + peer.txOff, n);
			peer.txOff += n;
		  }
		else if (peer.txEof && !peer.txEofSent)
		  {
			peer.sentNum++;
			peer_send (CHOP_EOF, peer.sentNum, NULL, 0);
			peer.txEofSent = 1;
		  }
		else
			break;
	  }
}

/* Automatic peer: react to one chaosd frame */
static void peer_auto_input (Frame* fr)
{
	if (fr->f[12] == 0x08 && fr->f[13] == 0x06)
	  {
		if (chaos_get16 (fr->f + 36) == PEER_ADDR && fr->f[21] == 1)
			peer_send_arp_reply ();
		return;
	  }
	if (!f_is_chaos (fr) || f_dest (fr) != PEER_ADDR)
		return;
	switch (f_op (fr))
	  {
	  case CHOP_RFC:
		if (!peer.opened)
		  {
			unsigned char d[4];
			peer.coreIndex = f_sidx (fr);
			peer.readNum = peer.receivedNum = f_num (fr);
			peer.opened = 1;
			peer.sentNum++;
			chaos_put16 (d, f_num (fr));
			chaos_put16 (d + 2, peer.window);
			peer_send (CHOP_OPN, peer.sentNum, d, 4);
			peer.nOpnSent++;
		  }
		break;
	  case CHOP_STS:
		peer.coreAcked = f_ack (fr);
		peer.coreWindow = chaos_get16 (f_data (fr) + 2);
		break;
	  case CHOP_SNS:
		peer_send_sts ();
		break;
	  case CHOP_CLS:
		peer.gotCls = 1;
		break;
	  case CHOP_LOS:
		peer.gotLos = 1;
		break;
	  default:
		if (f_op (fr) >= CHOP_DAT || f_op (fr) == CHOP_EOF)
		  {
			if (chaos_seq_lt (peer.coreAcked, f_ack (fr)))
				peer.coreAcked = f_ack (fr);
			if (f_num (fr) == (unsigned short) (peer.receivedNum + 1))
			  {
				if (f_op (fr) == CHOP_EOF)
					peer.rxEof = 1;
				else
				  {
					memcpy (peer.rx + peer.rxLen, f_data (fr), f_len (fr));
					peer.rxLen += f_len (fr);
				  }
				peer.receivedNum = peer.readNum = f_num (fr);
			  }
			peer_send_sts ();
		  }
		break;
	  }
}

/* Deliver chaosd's pending frames to the automatic peer */
static void pump_core_to_peer (void)
{
	while (coreOutRead < nCoreOut)
	  {
		Frame* fr = &coreOut[coreOutRead++];
		if (dropToPeer > 0 && f_is_chaos (fr))
		  {
			dropToPeer--;
			continue;
		  }
		if (peer.autoMode)
			peer_auto_input (fr);
		peer_push ();
	  }
	peer_push ();
}

/*** Tests ***/

static ChaosCore core;

static void fresh_core (void)
{
	chaos_core_init (&core, CORE_ADDR, coreMac, "CHAOSD-TEST", &capture, NULL);
	reset_capture ();
	dropToPeer = 0;
}

static void test_netid (void)
{
  char id[37];

	vlm_network_identifier (0xC0A80200, id);
	/* Computed independently: python3 uuid/hashlib over 192.168.2.0 */
	CHECK (0 == strcmp (id, "97CFF149-CD12-5CE0-8A33-11B2E025E146"), "netid: UUIDv5 of 192.168.2.0");
}

static void test_arp (void)
{
  unsigned char mac[6];
  Frame* r;
  static const unsigned char expectReplyTail[] =
	{ 0x08, 0x06, 0x00, 0x01, 0x08, 0x04, 0x06, 0x02, 0x00, 0x02 };

	fresh_core ();
	chaos_core_input (&core, capturedArp, sizeof (capturedArp), now);
	CHECK (1 == nCoreOut, "arp: one reply to the captured request");
	r = &coreOut[0];
	CHECK (r->n == 38, "arp: reply is 38 bytes before padding");
	CHECK (0 == memcmp (r->f, peerMac, 6), "arp: reply unicast to requester");
	CHECK (0 == memcmp (r->f + 6, coreMac, 6), "arp: reply from our MAC");
	CHECK (0 == memcmp (r->f + 12, expectReplyTail, sizeof (expectReplyTail)), "arp: reply header");
	CHECK (0 == memcmp (r->f + 22, coreMac, 6), "arp: SHA = us");
	CHECK (r->f[28] == 0x02 && r->f[29] == 0x01, "arp: SPA = 402 little-endian");
	CHECK (0 == memcmp (r->f + 30, peerMac, 6), "arp: THA = requester");
	CHECK (r->f[36] == 0x01 && r->f[37] == 0x01, "arp: TPA = 401 little-endian");
	CHECK (chaos_arp_lookup (&core, 0401, mac) && 0 == memcmp (mac, peerMac, 6),
		   "arp: request taught us 401's MAC");

	/* A request for another address is not answered */
	{
	  unsigned char other[sizeof (capturedArp)];
		memcpy (other, capturedArp, sizeof (other));
		other[36] = 0x03;
		reset_capture ();
		chaos_core_input (&core, other, sizeof (other), now);
		CHECK (0 == nCoreOut, "arp: request for 403 ignored");
	}

	/* Our own request has the captured shape with the roles swapped */
	fresh_core ();
	chaos_open (&core, PEER_ADDR, "SUPDUP", 6, now);
	CHECK (1 == nCoreOut, "arp: RFC to unknown host emits only an ARP request");
	r = &coreOut[0];
	{
	  unsigned char expect[38];
		memcpy (expect, capturedArp, sizeof (expect));
		memcpy (expect + 6, coreMac, 6);
		memcpy (expect + 22, coreMac, 6);
		expect[28] = 0x02; expect[29] = 0x01;		/* SPA 402 */
		expect[36] = 0x01; expect[37] = 0x01;		/* TPA 401 */
		CHECK (r->n == 38 && 0 == memcmp (r->f, expect, 38), "arp: request bytes");
	}
	/* Rate limit: no second request within 500 ms */
	now += 100;
	chaos_core_tick (&core, now);
	CHECK (1 == nCoreOut, "arp: request rate-limited");
	now += 500;
	chaos_core_tick (&core, now);
	CHECK (2 == nCoreOut && coreOut[1].f[13] == 0x06, "arp: request retried after 500 ms");
}

static int open_conn (unsigned short window)
{
  int h;

	peer_reset (&core, window);
	peer.autoMode = 1;
	h = chaos_open (&core, PEER_ADDR, "SUPDUP", 6, now);
	pump_core_to_peer ();
	pump_core_to_peer ();
	return (h);
}

static void test_handshake (void)
{
  int h;
  Frame* rfc;
  Frame* sts;
  ChaosConn* k;

	fresh_core ();
	core.initialPktNum = 0x0500;
	peer_reset (&core, 5);
	h = chaos_open (&core, PEER_ADDR, "SUPDUP", 6, now);
	CHECK (h >= 0, "handshake: chaos_open");
	CHECK (CONN_RFC_SENT == chaos_state (&core, h), "handshake: RFC_SENT");
	peer_send_arp_reply ();
	rfc = last_op (CHOP_RFC);
	CHECK (rfc != NULL, "handshake: RFC sent as soon as ARP resolves");
	if (NULL == rfc)
		return;
	CHECK (rfc->f[14] == 0 && rfc->f[15] == 001, "handshake: opcode in the high byte (frame byte 15)");
	CHECK (0 == memcmp (rfc->f, peerMac, 6), "handshake: RFC to the peer MAC");
	CHECK (f_dest (rfc) == PEER_ADDR && f_didx (rfc) == 0, "handshake: RFC dest 401 index 0");
	CHECK (f_src (rfc) == CORE_ADDR && f_sidx (rfc) != 0, "handshake: RFC src 402, nonzero index");
	CHECK (f_num (rfc) == 0x0500, "handshake: RFC packet number");
	CHECK (f_len (rfc) == 6 && 0 == memcmp (f_data (rfc), "SUPDUP", 6), "handshake: RFC contact");
	CHECK (rfc->n == 36, "handshake: frame length 30 + data");

	peer.coreIndex = f_sidx (rfc);
	peer.readNum = peer.receivedNum = f_num (rfc);
	{
	  unsigned char d[4];
		chaos_put16 (d, f_num (rfc));
		chaos_put16 (d + 2, 5);
		reset_capture ();
		peer_send (CHOP_OPN, 0x7001, d, 4);
	}
	CHECK (CONN_OPEN == chaos_state (&core, h), "handshake: OPEN after OPN");
	k = chaos_conn (&core, h);
	CHECK (k->remoteIndex == peer.index, "handshake: learned remote index");
	CHECK (k->remoteWindow == 5, "handshake: remote window from OPN word 2");
	sts = last_op (CHOP_STS);
	CHECK (sts != NULL && 1 == nCoreOut, "handshake: STS answers OPN");
	if (sts != NULL)
	  {
		CHECK (f_num (sts) == 0, "handshake: STS packet# 0");
		CHECK (f_ack (sts) == 0x7001, "handshake: STS acks OPN");
		CHECK (chaos_get16 (f_data (sts)) == 0x7001, "handshake: STS receipt = OPN");
		CHECK (chaos_get16 (f_data (sts) + 2) == CHAOS_DEFAULT_WINDOW, "handshake: STS window 13");
		CHECK (f_didx (sts) == peer.index, "handshake: STS to remote index");
	  }
	CHECK (chaos_send_room (&core, h) == 5 * CHAOS_MAX_DATA, "handshake: room = window * 488");

	/* Duplicate OPN (our STS lost): answered with STS again */
	reset_capture ();
	{
	  unsigned char d[4];
		chaos_put16 (d, 0x0500);
		chaos_put16 (d + 2, 5);
		peer_send (CHOP_OPN, 0x7001, d, 4);
	}
	CHECK (1 == count_op (0, CHOP_STS), "handshake: duplicate OPN -> STS");

	/* No retransmission of the (receipted) RFC */
	reset_capture ();
	now += 2000;
	chaos_core_tick (&core, now);
	CHECK (0 == count_op (0, CHOP_RFC), "handshake: RFC not retransmitted after OPN");
}

static void fill_pattern (unsigned char* p, size_t n, unsigned seed)
{
  size_t i;

	for (i = 0; i < n; i++)
		p[i] = (unsigned char) ((i * 7 + seed + (i >> 8)) & 0xFF);
}

static void test_send_window (void)
{
  static unsigned char data[20000];
  size_t total = 10 * CHAOS_MAX_DATA + 100, sent = 0;
  int h, from, rounds = 0;

	fresh_core ();
	h = open_conn (3);
	CHECK (CONN_OPEN == chaos_state (&core, h), "send: open");
	fill_pattern (data, total, 3);

	/* Hold the peer's acks so the window really closes */
	from = nCoreOut;
	sent = chaos_send (&core, h, data, total, now);
	CHECK (sent == 3 * CHAOS_MAX_DATA, "send: window of 3 limits the first burst");
	CHECK (3 == count_op (from, CHOP_DAT), "send: 3 DAT packets emitted");
	CHECK (0 == chaos_send_room (&core, h), "send: no room with window full");
	CHECK (0 == chaos_send (&core, h, data + sent, total - sent, now), "send: refuses beyond window");
	{
	  Frame* d = &coreOut[from];
		CHECK (f_op (d) == CHOP_DAT && f_len (d) == 488, "send: DAT opcode 0200, 488 bytes");
		CHECK (f_ack (d) == 0x7001, "send: DAT piggybacks ack of OPN");
	}
	while (sent < total && rounds++ < 100)
	  {
		pump_core_to_peer ();
		sent += chaos_send (&core, h, data + sent, total - sent, now);
	  }
	pump_core_to_peer ();
	CHECK (sent == total, "send: whole stream accepted as acks arrived");
	CHECK (peer.rxLen == total && 0 == memcmp (peer.rx, data, total), "send: peer reassembled the stream");
	CHECK (chaos_conn (&core, h)->receiptNum == chaos_conn (&core, h)->sentNum,
		   "send: everything receipted");
}

static void test_recv_window (void)
{
  static unsigned char data[40000], got[40000];
  size_t total = 30 * CHAOS_MAX_DATA + 7, gotLen = 0;
  int h, from, i;
  Frame* sts;

	fresh_core ();
	h = open_conn (13);
	fill_pattern (data, total, 9);

	/* The peer deliberately oversends: 14 packets against a window of 13 */
	from = nCoreOut;
	for (i = 0; i < 14; i++)
	  {
		peer.sentNum++;
		peer_send (CHOP_DAT, peer.sentNum, data + i * CHAOS_MAX_DATA, CHAOS_MAX_DATA);
	  }
	CHECK (1 == count_op (from, CHOP_STS), "recv: over-window packet draws STS");
	sts = last_op (CHOP_STS);
	CHECK (sts && chaos_get16 (f_data (sts)) == (unsigned short) (peer.sentNum - 1),
		   "recv: STS receipt covers the 13 in-window packets");
	CHECK (sts && f_ack (sts) == (unsigned short) (peer.sentNum - 14), "recv: nothing consumed yet");
	CHECK (core.nOverWindow == 1, "recv: over-window counted");

	/* The user reads: window reopens, STS carries the ack */
	from = nCoreOut;
	gotLen = chaos_recv (&core, h, got, sizeof (got), now);
	CHECK (gotLen == 13 * CHAOS_MAX_DATA, "recv: 13 packets readable");
	CHECK (count_op (from, CHOP_STS) >= 1, "recv: STS after consuming past half window");
	sts = last_op (CHOP_STS);
	CHECK (sts && f_ack (sts) == (unsigned short) (peer.sentNum - 1), "recv: STS acks consumed packets");

	/* Peer resends 14 and the rest */
	peer.sentNum--;
	for (i = 13; (size_t) i * CHAOS_MAX_DATA < total; i++)
	  {
		size_t n = total - (size_t) i * CHAOS_MAX_DATA;
		if (n > CHAOS_MAX_DATA)
			n = CHAOS_MAX_DATA;
		peer.sentNum++;
		peer_send (CHOP_DAT, peer.sentNum, data + i * CHAOS_MAX_DATA, n);
		if (i % 5 == 0)
			gotLen += chaos_recv (&core, h, got + gotLen, sizeof (got) - gotLen, now);
	  }
	gotLen += chaos_recv (&core, h, got + gotLen, sizeof (got) - gotLen, now);
	CHECK (gotLen == total && 0 == memcmp (got, data, total), "recv: stream intact in order");

	/* Delayed ack: a lone small packet gets its STS from the tick */
	from = nCoreOut;
	peer.sentNum++;
	peer_send (CHOP_DAT, peer.sentNum, "x", 1);
	chaos_recv (&core, h, got, 10, now);
	CHECK (0 == count_op (from, CHOP_STS), "recv: small read does not STS at once");
	now += CHAOS_ACK_DELAY_MS;
	chaos_core_tick (&core, now);
	CHECK (1 == count_op (from, CHOP_STS), "recv: delayed STS from tick");
	CHECK (f_ack (last_op (CHOP_STS)) == peer.sentNum, "recv: delayed STS acks it");

	/* Partial reads keep the packet until fully consumed */
	peer.sentNum++;
	peer_send (CHOP_DAT, peer.sentNum, "abcdef", 6);
	CHECK (2 == chaos_recv (&core, h, got, 2, now) && 0 == memcmp (got, "ab", 2), "recv: partial read");
	CHECK (chaos_conn (&core, h)->readNum == (unsigned short) (peer.sentNum - 1), "recv: partial read not acked");
	CHECK (4 == chaos_recv (&core, h, got, 10, now) && 0 == memcmp (got, "cdef", 4), "recv: rest of packet");
}

static void test_retransmit (void)
{
  int h, from;
  Frame* d;
  unsigned short num;

	fresh_core ();
	h = open_conn (13);
	peer.autoMode = 1;
	dropToPeer = 1;
	from = nCoreOut;
	chaos_send (&core, h, (const unsigned char*) "hello", 5, now);
	pump_core_to_peer ();					/* Dropped */
	CHECK (0 == peer.rxLen, "retransmit: first copy lost");
	d = &coreOut[from];
	num = f_num (d);

	now += CHAOS_RETRANSMIT_MS - 10;
	chaos_core_tick (&core, now);
	CHECK (1 == count_op (from, CHOP_DAT), "retransmit: not before 500 ms");
	now += 20;
	chaos_core_tick (&core, now);
	CHECK (2 == count_op (from, CHOP_DAT), "retransmit: after 500 ms");
	CHECK (f_num (last_op (CHOP_DAT)) == num, "retransmit: same packet number");
	pump_core_to_peer ();
	CHECK (peer.rxLen == 5 && 0 == memcmp (peer.rx, "hello", 5), "retransmit: delivered");
	from = nCoreOut;
	now += 2000;
	chaos_core_tick (&core, now);
	CHECK (0 == count_op (from, CHOP_DAT), "retransmit: stops once receipted");

	/* Lost RFC is retransmitted too */
	fresh_core ();
	peer_reset (&core, 13);
	peer_send_arp_reply ();
	reset_capture ();
	h = chaos_open (&core, PEER_ADDR, "SUPDUP", 6, now);
	CHECK (1 == count_op (0, CHOP_RFC), "retransmit: RFC sent");
	now += 600;
	chaos_core_tick (&core, now);
	CHECK (2 == count_op (0, CHOP_RFC) && f_num (&coreOut[0]) == f_num (last_op (CHOP_RFC)),
		   "retransmit: RFC retransmitted with same number");
	(void) h;
}

static void test_dup_ooo (void)
{
  int h, from;
  unsigned char got[64];
  unsigned short base;
  size_t n;

	fresh_core ();
	h = open_conn (13);
	base = peer.sentNum;
	from = nCoreOut;
	peer_send (CHOP_DAT, (unsigned short) (base + 2), "BB", 2);
	CHECK (!chaos_recv_ready (&core, h), "ooo: gap blocks delivery");
	CHECK (1 == count_op (from, CHOP_STS), "ooo: out-of-order arrival draws STS");
	CHECK (chaos_get16 (f_data (last_op (CHOP_STS))) == base, "ooo: STS receipt still at the gap");
	peer_send (CHOP_DAT, (unsigned short) (base + 3), "CC", 2);
	peer_send (CHOP_DAT, (unsigned short) (base + 1), "AA", 2);
	CHECK (chaos_conn (&core, h)->receivedNum == (unsigned short) (base + 3), "ooo: gap filled, receipt jumps");
	n = chaos_recv (&core, h, got, sizeof (got), now);
	CHECK (n == 6 && 0 == memcmp (got, "AABBCC", 6), "ooo: delivered in order");

	/* Duplicate of a consumed packet */
	from = nCoreOut;
	peer_send (CHOP_DAT, (unsigned short) (base + 2), "BB", 2);
	CHECK (1 == count_op (from, CHOP_STS), "dup: old packet draws STS");
	CHECK (!chaos_recv_ready (&core, h), "dup: not delivered twice");
	CHECK (core.nDuplicates == 1, "dup: counted");

	/* Duplicate of a buffered out-of-order packet */
	peer_send (CHOP_DAT, (unsigned short) (base + 5), "EE", 2);
	from = nCoreOut;
	peer_send (CHOP_DAT, (unsigned short) (base + 5), "EE", 2);
	CHECK (1 == count_op (from, CHOP_STS) && core.nDuplicates == 2, "dup: buffered duplicate");
	peer_send (CHOP_DAT, (unsigned short) (base + 4), "DD", 2);
	n = chaos_recv (&core, h, got, sizeof (got), now);
	CHECK (n == 4 && 0 == memcmp (got, "DDEE", 4), "dup: stream continues");
}

static void test_sts_sns (void)
{
  int h, from;
  unsigned char d[4];

	fresh_core ();
	h = open_conn (2);
	from = nCoreOut;
	peer_send (CHOP_SNS, 0, NULL, 0);
	CHECK (1 == count_op (from, CHOP_STS), "sns: answered with STS");
	CHECK (chaos_get16 (f_data (last_op (CHOP_STS))) == peer.sentNum, "sns: STS receipt");

	/* STS raises the window */
	CHECK (chaos_send_room (&core, h) == 2 * CHAOS_MAX_DATA, "sts: window 2 from OPN");
	chaos_put16 (d, peer.receivedNum);
	chaos_put16 (d + 2, 7);
	peer_send (CHOP_STS, 0, d, 4);
	CHECK (chaos_send_room (&core, h) == 7 * CHAOS_MAX_DATA, "sts: window raised to 7");

	/* STS receipt without ack stops retransmission but keeps the window */
	peer.autoMode = 0;
	from = nCoreOut;
	chaos_send (&core, h, (const unsigned char*) "12345", 5, now);
	chaos_put16 (d, (unsigned short) chaos_conn (&core, h)->sentNum);
	peer_send (CHOP_STS, 0, d, 4);			/* ack field still old */
	CHECK (chaos_send_room (&core, h) == 6 * CHAOS_MAX_DATA, "sts: receipt does not open the window");
	now += 1000;
	chaos_core_tick (&core, now);
	CHECK (1 == count_op (from, CHOP_DAT), "sts: receipted packet not retransmitted");

	/* Probe: unacked data and silence draw SNS after 5 s */
	now += CHAOS_PROBE_MS;
	chaos_core_tick (&core, now);
	CHECK (count_op (from, CHOP_SNS) >= 1, "sns: probe sent while unacked");

	/* Host down after 90 s of silence */
	now += CHAOS_HOST_DOWN_MS;
	chaos_core_tick (&core, now);
	CHECK (CONN_CLOSED == chaos_state (&core, h) && CLOSE_TIMEOUT == chaos_conn (&core, h)->closeKind,
		   "sns: host-down timeout closes");
}

static void test_eof_cls (void)
{
  int h, from;
  unsigned char got[64];
  Frame* cls;

	/* Our finish: EOF, peer acks, CLS */
	fresh_core ();
	h = open_conn (13);
	chaos_send (&core, h, (const unsigned char*) "bye", 3, now);
	from = nCoreOut;
	chaos_finish (&core, h, now);
	CHECK (1 == count_op (from, CHOP_EOF), "eof: EOF sent");
	CHECK (0 == chaos_send_room (&core, h), "eof: no sending after finish");
	pump_core_to_peer ();
	CHECK (peer.rxEof && peer.rxLen == 3, "eof: peer got data then EOF");
	CHECK (1 == count_op (from, CHOP_CLS), "eof: CLS after EOF acknowledged");
	CHECK (CONN_CLOSED == chaos_state (&core, h) && CLOSE_DONE == chaos_conn (&core, h)->closeKind,
		   "eof: closed DONE");
	CHECK (peer.gotCls, "eof: peer saw CLS");
	chaos_release (&core, h, "", now);
	CHECK (CONN_FREE == chaos_state (&core, h), "eof: released");

	/* EOF with the window full waits for room */
	fresh_core ();
	h = open_conn (1);
	peer.autoMode = 0;
	coreOutRead = nCoreOut;					/* Peer stops listening */
	chaos_send (&core, h, (const unsigned char*) "x", 1, now);
	from = nCoreOut;
	chaos_finish (&core, h, now);
	CHECK (0 == count_op (from, CHOP_EOF), "eof: waits for window");
	peer_send (CHOP_STS, 0, "\0\0\1\0", 4);	/* Bogus receipt 0: ignored */
	peer.readNum = peer.receivedNum = chaos_conn (&core, h)->sentNum;
	{
	  unsigned char d[4];
		chaos_put16 (d, peer.receivedNum);
		chaos_put16 (d + 2, 1);
		peer_send (CHOP_STS, 0, d, 4);
	}
	CHECK (1 == count_op (from, CHOP_EOF), "eof: sent when window opened");
	now += CHAOS_FINISH_TIMEOUT_MS;
	chaos_core_tick (&core, now);
	CHECK (CONN_CLOSED == chaos_state (&core, h) && 1 == count_op (from, CHOP_CLS),
		   "eof: CLS anyway when EOF never acked");

	/* Peer's EOF and CLS */
	fresh_core ();
	h = open_conn (13);
	peer.sentNum++;
	peer_send (CHOP_DAT, peer.sentNum, "tail", 4);
	peer.sentNum++;
	peer_send (CHOP_EOF, peer.sentNum, NULL, 0);
	CHECK (!chaos_recv_eof (&core, h), "peer eof: not before reading");
	from = nCoreOut;
	CHECK (4 == chaos_recv (&core, h, got, sizeof (got), now), "peer eof: data first");
	CHECK (chaos_recv_eof (&core, h), "peer eof: then EOF");
	CHECK (count_op (from, CHOP_STS) >= 1 && f_ack (last_op (CHOP_STS)) == peer.sentNum,
		   "peer eof: EOF acknowledged at once");
	peer_send (CHOP_CLS, 0, "Logged out", 10);
	CHECK (CONN_CLOSED == chaos_state (&core, h) && CLOSE_CLS == chaos_conn (&core, h)->closeKind,
		   "peer cls: closed");
	CHECK (0 == strcmp (chaos_conn (&core, h)->reason, "Logged out"), "peer cls: reason kept");
	from = nCoreOut;
	chaos_release (&core, h, "x", now);
	CHECK (0 == count_op (from, CHOP_CLS), "peer cls: no CLS back");

	/* Release of an open connection sends CLS */
	fresh_core ();
	h = open_conn (13);
	from = nCoreOut;
	chaos_release (&core, h, "User went away", now);
	cls = last_op (CHOP_CLS);
	CHECK (1 == count_op (from, CHOP_CLS) && cls && f_len (cls) == 14 &&
		   0 == memcmp (f_data (cls), "User went away", 14), "release: CLS with reason");

	/* LOS from the peer */
	fresh_core ();
	h = open_conn (13);
	peer_send (CHOP_LOS, 0, "Broken", 6);
	CHECK (CLOSE_LOS == chaos_conn (&core, h)->closeKind, "peer los: closed LOS");
}

static void test_wraparound (void)
{
  static unsigned char data[30000], got[30000];
  size_t total = 40 * CHAOS_MAX_DATA / 2, sent = 0, gotLen = 0;
  int h, rounds = 0;

	fresh_core ();
	core.initialPktNum = 0xFFF8;
	peer_reset (&core, 4);
	peer.autoMode = 1;
	peer.sentNum = 0xFFF0;
	h = chaos_open (&core, PEER_ADDR, "SUPDUP", 6, now);
	pump_core_to_peer ();
	pump_core_to_peer ();
	CHECK (CONN_OPEN == chaos_state (&core, h), "wrap: open");
	CHECK (chaos_conn (&core, h)->sentNum == 0xFFF8, "wrap: RFC numbered 0xFFF8");

	fill_pattern (data, total, 21);
	memcpy (peer.tx, data, total);
	peer.txLen = total;
	while ((sent < total || gotLen < total) && rounds++ < 2000)
	  {
		sent += chaos_send (&core, h, data + sent, total - sent, now);
		gotLen += chaos_recv (&core, h, got + gotLen, sizeof (got) - gotLen, now);
		now += 10;
		chaos_core_tick (&core, now);
		pump_core_to_peer ();
	  }
	CHECK (peer.rxLen == total && 0 == memcmp (peer.rx, data, total), "wrap: out through 0xFFFF");
	CHECK (gotLen == total && 0 == memcmp (got, data, total), "wrap: in through 0xFFFF");
	CHECK (chaos_seq_lt (0xFFF8, chaos_conn (&core, h)->sentNum) &&
		   chaos_conn (&core, h)->sentNum < 0x100, "wrap: our numbers wrapped");
	CHECK (chaos_conn (&core, h)->readNum < 0x100, "wrap: peer numbers wrapped");
	CHECK (chaos_seq_lt (0xFFFF, 0x0000) && !chaos_seq_lt (0x0000, 0xFFFF), "wrap: seq compare");
}

static void test_incoming (void)
{
  Frame* r;
  unsigned char d[4];

	fresh_core ();
	peer_reset (&core, 13);
	peer_send_arp_reply ();
	reset_capture ();
	peer_send_raw (CHOP_RFC, 0, 0x5555, 0x0200, 0, "STATUS", 6);
	r = last_op (CHOP_ANS);
	CHECK (r != NULL && 1 == nCoreOut, "status: ANS");
	if (r != NULL)
	  {
		CHECK (f_len (r) == 32, "status: 32 bytes");
		CHECK (0 == memcmp (f_data (r), "CHAOSD-TEST\0\0\0", 14), "status: name, zero padded");
		CHECK (f_didx (r) == 0x5555 && f_dest (r) == PEER_ADDR, "status: to requester's index");
	  }

	reset_capture ();
	peer_send_raw (CHOP_RFC, 0, 0x5556, 0x0200, 0, "TELNET foo", 10);
	r = last_op (CHOP_CLS);
	CHECK (r != NULL && f_didx (r) == 0x5556, "rfc: other contacts refused with CLS");
	CHECK (r && 0 == memcmp (f_data (r), "No server for contact name TELNET", 33), "rfc: reason");

	reset_capture ();
	peer_send_raw (CHOP_DAT, 0x0421, 0x5557, 5, 0, "zz", 2);
	r = last_op (CHOP_LOS);
	CHECK (r != NULL && f_didx (r) == 0x5557 && f_sidx (r) == 0x0421, "los: DAT to no connection");
	reset_capture ();
	chaos_put16 (d, 0); chaos_put16 (d + 2, 1);
	peer_send_raw (CHOP_CLS, 0x0421, 0x5557, 0, 0, "x", 1);
	peer_send_raw (CHOP_LOS, 0x0421, 0x5557, 0, 0, "x", 1);
	CHECK (0 == nCoreOut, "los: replies to nothing are dropped silently");

	/* Frames for other hosts are ignored */
	{
	  unsigned char f[60];
		memset (f, 0, sizeof (f));
		memset (f, 0xFF, 6);
		memcpy (f + 6, peerMac, 6);
		f[12] = 0x08; f[13] = 0x04; f[15] = CHOP_RFC;
		chaos_put16 (f + 16, 6);
		chaos_put16 (f + 18, 0403);
		chaos_put16 (f + 22, PEER_ADDR);
		memcpy (f + 30, "STATUS", 6);
		chaos_core_input (&core, f, sizeof (f), now);
		CHECK (0 == nCoreOut, "rfc: for 403 ignored");
	}
}

static void test_rfc_failures (void)
{
  int h;

	fresh_core ();
	peer_reset (&core, 13);
	peer_send_arp_reply ();
	h = chaos_open (&core, PEER_ADDR, "NOSUCH", 6, now);
	peer_send_raw (CHOP_CLS, f_sidx (last_op (CHOP_RFC)), 0, 0, 0, "No server", 9);
	CHECK (CONN_CLOSED == chaos_state (&core, h) && CLOSE_CLS == chaos_conn (&core, h)->closeKind,
		   "rfc: CLS refuses");
	chaos_release (&core, h, "", now);

	h = chaos_open (&core, PEER_ADDR, "STATUS", 6, now);
	peer_send_raw (CHOP_ANS, f_sidx (last_op (CHOP_RFC)), 0, 0, 0, "GENERA", 6);
	CHECK (CLOSE_ANS == chaos_conn (&core, h)->closeKind &&
		   6 == chaos_conn (&core, h)->reasonBytes, "rfc: ANS kept");
	chaos_release (&core, h, "", now);

	h = chaos_open (&core, 0404, "SUPDUP", 6, now);
	now += CHAOS_RFC_TIMEOUT_MS;
	chaos_core_tick (&core, now);
	CHECK (CLOSE_TIMEOUT == chaos_conn (&core, h)->closeKind, "rfc: unanswered RFC times out");
	chaos_release (&core, h, "", now);
}


/*** Stream front end ***/

static StreamServer server;

static void stream_pump (int iterations)
{
  int i;

	for (i = 0; i < iterations; i++)
	  {
		stream_step (&server, -1, 0);
		now += 5;
		chaos_core_tick (&core, now);
		pump_core_to_peer ();
		stream_service (&server, now);
	  }
}

static ssize_t read_some (int fd, char* buf, size_t max)
{
  struct pollfd p;

	p.fd = fd;
	p.events = POLLIN;
	if (poll (&p, 1, 0) <= 0)
		return (-2);
	return (read (fd, buf, max));
}

static ssize_t read_line (int fd, char* buf, size_t max)
{
  size_t n = 0;
  int spins = 0;

	while (n + 1 < max)
	  {
		char c;
		ssize_t r;
		stream_pump (1);
		r = read_some (fd, &c, 1);
		if (-2 == r)
		  {
			if (++spins > 5000)
				break;
			continue;
		  }
		if (r <= 0)
			return (-1);
		buf[n++] = c;
		if ('\n' == c)
			break;
	  }
	buf[n] = 0;
	return ((ssize_t) n);
}

static int new_client (void)
{
  int sv[2];

	if (socketpair (AF_UNIX, SOCK_STREAM, 0, sv) < 0)
		return (-1);
	stream_adopt (&server, sv[1]);
	fcntl (sv[0], F_SETFL, fcntl (sv[0], F_GETFL, 0) | O_NONBLOCK);
	return (sv[0]);
}

static void test_stream (void)
{
  char line[600];
  static unsigned char big[20000], got[20000];
  size_t total = sizeof (big), gotLen = 0, off = 0;
  int fd, i;
  ssize_t n;

	fresh_core ();
	peer_reset (&core, 13);
	peer.autoMode = 1;
	stream_init (&server, &core, &fake_clock);
	CHECK (stream_add_host (&server, "genera=401"), "stream: -H genera=401");
	CHECK (!stream_add_host (&server, "bad=9"), "stream: -H rejects non-octal");

	/* supdup's exchange, by name */
	fd = new_client ();
	(void) !write (fd, "RFC genera SUPDUP\r\n", 19);
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strcmp (line, "OPN Connection to host 401\r\n"), "stream: OPN line");
	CHECK (peer.opened && peer.nOpnSent == 1, "stream: peer saw one RFC");
	{
	  ChaosConn* k = chaos_conn (&core, server.clients[0].conn);
		CHECK (k && 0 == memcmp (k->sendq[0].data, "", 0), "stream: conn exists");
	}

	/* Client -> Genera, larger than the window */
	fill_pattern (big, total, 33);
	for (i = 0; i < 400 && peer.rxLen < total; i++)
	  {
		if (off < total)
		  {
			ssize_t w = write (fd, big + off, total - off);
			if (w > 0)
				off += (size_t) w;
		  }
		stream_pump (1);
	  }
	CHECK (peer.rxLen == total && 0 == memcmp (peer.rx, big, total), "stream: client->chaos bytes intact");

	/* Genera -> client */
	fill_pattern (peer.tx, total, 44);
	peer.txLen = total;
	peer_push ();
	for (i = 0; i < 400 && gotLen < total; i++)
	  {
		stream_pump (1);
		n = read_some (fd, (char*) got + gotLen, total - gotLen);
		if (n > 0)
			gotLen += (size_t) n;
	  }
	CHECK (gotLen == total && 0 == memcmp (got, peer.tx, total), "stream: chaos->client bytes intact");

	/* Peer EOF: client sees end of stream */
	peer.txEof = 1;
	peer_push ();
	for (i = 0, n = -2; i < 50 && -2 == n; i++)
	  {
		stream_pump (1);
		n = read_some (fd, line, sizeof (line));
	  }
	CHECK (0 == n, "stream: peer EOF -> socket EOF");

	/* Client closes: EOF + CLS on the wire, slot freed */
	close (fd);
	stream_pump (20);
	CHECK (peer.gotCls, "stream: client close -> CLS after EOF");
	CHECK (0 == stream_active_clients (&server), "stream: client slot freed");
	CHECK (count_op (0, CHOP_EOF) == 1, "stream: exactly one EOF sent");

	/* Refused RFC */
	fresh_core ();
	peer_reset (&core, 13);
	peer_send_arp_reply ();
	stream_init (&server, &core, &fake_clock);
	fd = new_client ();
	(void) !write (fd, "RFC 401 NOSUCH\r\n", 16);
	stream_pump (2);
	peer_send_raw (CHOP_CLS, f_sidx (last_op (CHOP_RFC)), 0, 0, 0, "No server for NOSUCH", 20);
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strcmp (line, "CLS No server for NOSUCH\r\n"), "stream: CLS line");
	stream_pump (2);
	CHECK (0 == read_some (fd, line, sizeof (line)), "stream: closed after CLS line");
	close (fd);

	/* ANS for a simple contact */
	fd = new_client ();
	(void) !write (fd, "RFC 401 STATUS\n", 15);
	stream_pump (2);
	peer_send_raw (CHOP_ANS, f_sidx (last_op (CHOP_RFC)), 0, 0, 0, "GEN\0", 4);
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strcmp (line, "ANS 4\r\n"), "stream: ANS line");
	stream_pump (2);
	n = read_some (fd, line, sizeof (line));
	CHECK (4 == n && 0 == memcmp (line, "GEN\0", 4), "stream: ANS data");
	close (fd);

	/* Timeout */
	fd = new_client ();
	(void) !write (fd, "RFC 404 SUPDUP\r\n", 16);
	stream_pump (2);
	now += CHAOS_RFC_TIMEOUT_MS;
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strncmp (line, "LOS Timed out", 13), "stream: timeout line");
	close (fd);

	/* Bad requests */
	fd = new_client ();
	(void) !write (fd, "RFC nosuchhost SUPDUP\r\n", 23);
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strcmp (line, "LOS Unknown host nosuchhost\r\n"), "stream: unknown host");
	close (fd);
	fd = new_client ();
	(void) !write (fd, "HELLO\r\n", 7);
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strncmp (line, "LOS ", 4), "stream: non-RFC rejected");
	close (fd);
	stream_pump (5);
	CHECK (0 == stream_active_clients (&server), "stream: all failed clients freed");

	/* Client vanishes mid-stream: CLS to the peer */
	fresh_core ();
	peer_reset (&core, 13);
	peer.autoMode = 1;
	stream_init (&server, &core, &fake_clock);
	fd = new_client ();
	(void) !write (fd, "RFC 401 SUPDUP\r\nearly", 21);	/* Data right after the line */
	n = read_line (fd, line, sizeof (line));
	CHECK (n > 0 && 0 == strncmp (line, "OPN ", 4), "stream: OPN (2)");
	stream_pump (5);
	CHECK (peer.rxLen == 5 && 0 == memcmp (peer.rx, "early", 5), "stream: bytes after RFC line are data");
	close (fd);
	stream_pump (20);
	CHECK (peer.gotCls && 0 == stream_active_clients (&server), "stream: hangup -> EOF/CLS, freed");

	/* A real listening socket, as supdup's chaos.c uses it */
	{
	  char dir[] = "/tmp/chaosd-test.XXXXXX";
	  char path[128];
	  struct sockaddr_un sun;
		if (NULL == mkdtemp (dir))
		  {
			CHECK (0, "listen: mkdtemp");
			return;
		  }
		snprintf (path, sizeof (path), "%s/chaos_stream", dir);
		fresh_core ();
		peer_reset (&core, 13);
		peer.autoMode = 1;
		stream_init (&server, &core, &fake_clock);
		CHECK (stream_listen (&server, path) >= 0, "listen: bind");
		{
		  StreamServer other;
			stream_init (&other, &core, &fake_clock);
			CHECK (stream_listen (&other, path) < 0 && EADDRINUSE == errno,
				   "listen: refuses while another daemon is live");
		}
		fd = socket (AF_UNIX, SOCK_STREAM, 0);
		memset (&sun, 0, sizeof (sun));
		sun.sun_family = AF_UNIX;
		strlcpy (sun.sun_path, path, sizeof (sun.sun_path));
		CHECK (0 == connect (fd, (struct sockaddr*) &sun, sizeof (sun)), "listen: connect");
		(void) !write (fd, "RFC 401 SUPDUP\r\n", 16);
		n = read_line (fd, line, sizeof (line));
		CHECK (n > 0 && 0 == strcmp (line, "OPN Connection to host 401\r\n"), "listen: OPN over the named socket");
		close (fd);
		stream_pump (20);
		stream_shutdown (&server, now);
		unlink (path);
		rmdir (dir);
	  }
}

int main (void)
{
	setvbuf (stdout, NULL, _IONBF, 0);
	printf ("-- netid\n");
	test_netid ();
	printf ("-- arp\n");
	test_arp ();
	printf ("-- handshake\n");
	test_handshake ();
	printf ("-- send_window\n");
	test_send_window ();
	printf ("-- recv_window\n");
	test_recv_window ();
	printf ("-- retransmit\n");
	test_retransmit ();
	printf ("-- dup_ooo\n");
	test_dup_ooo ();
	printf ("-- sts_sns\n");
	test_sts_sns ();
	printf ("-- eof_cls\n");
	test_eof_cls ();
	printf ("-- wraparound\n");
	test_wraparound ();
	printf ("-- incoming\n");
	test_incoming ();
	printf ("-- rfc_failures\n");
	test_rfc_failures ();
	printf ("-- stream\n");
	test_stream ();
	printf ("%d checks, %d failures\n", checks, failures);
	return (failures ? 1 : 0);
}
