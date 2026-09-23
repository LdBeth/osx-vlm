/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd protocol core: Chaos-over-Ethernet, chaos-ARP and a small NCP.
 *
 * The core is pure: frames come in through chaos_core_input (), frames go
 * out through the emit callback, and time is whatever the caller passes
 * as nowMs.  No vmnet, no sockets, no root -- the unit tests drive it
 * directly.
 *
 * Wire format (Chaos-over-Ethernet, ethertype 0x0804):
 *   eth[0..13]  dst MAC, src MAC, ethertype (network order)
 *   ch[0..15]   eight LITTLE-endian 16-bit words:
 *                 opcode<<8 (opcode is byte ch[1], frame byte 15),
 *                 nbytes (low 12 bits) | forwarding count (high 4),
 *                 dest addr, dest index, src addr, src index,
 *                 packet#, ack#
 *   ch[16..]    data, at most 488 bytes, bytes in natural order.
 * Chaos ARP is ordinary ARP (ethertype 0x0806, htype 1, ptype 0x0804,
 * hlen 6, plen 2) whose 2-byte protocol addresses are little-endian.
 *
 * NCP semantics follow the Genera 9.0 NCP (SYS:NETWORK;CHAOS-NCP):
 * packet numbers are 16-bit and compared modulo 2^16; STS/SNS carry
 * packet# 0; STS data = receipt, window; OPN data = receipt, window;
 * a packet's ack# is the last packet the receiving USER has consumed and
 * opens the sender's window; the receipt only stops retransmission.
 */

#ifndef CHAOS_CORE_H
#define CHAOS_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifndef TRUE
#define TRUE 1
#define FALSE 0
#endif
typedef int boolean;

#define CHAOS_ETHERTYPE			0x0804
#define ARP_ETHERTYPE			0x0806

#define CHAOS_ETH_HEADER		14
#define CHAOS_HEADER			16
#define CHAOS_MAX_DATA			488
#define CHAOS_MAX_FRAME			(CHAOS_ETH_HEADER + CHAOS_HEADER + CHAOS_MAX_DATA)
#define CHAOS_ARP_FRAME			(CHAOS_ETH_HEADER + 8 + 6 + 2 + 6 + 2)	/* 38 */

/* Opcodes (octal in the Chaosnet documents) */
#define CHOP_RFC	001
#define CHOP_OPN	002
#define CHOP_CLS	003
#define CHOP_FWD	004
#define CHOP_ANS	005
#define CHOP_SNS	006
#define CHOP_STS	007
#define CHOP_RUT	010
#define CHOP_LOS	011
#define CHOP_LSN	012
#define CHOP_MNT	013
#define CHOP_EOF	014
#define CHOP_UNC	015
#define CHOP_BRD	016
#define CHOP_DAT	0200

/* Sizes and policy */
#define CHAOS_MAX_CONNS			32		/* Power of two: low index bits = slot */
#define CHAOS_RING				64		/* Power of two, > any window */
#define CHAOS_MAX_WINDOW		50		/* Genera's *maximum-window-size* */
#define CHAOS_DEFAULT_WINDOW	13		/* Genera's *default-window-size* */
#define CHAOS_ARP_ENTRIES		64

#define CHAOS_RETRANSMIT_MS		500		/* Genera: *retransmit-interval* 0.5 s */
#define CHAOS_STS_RETRANSMIT_MS	100		/* Retransmit sooner after a receipt */
#define CHAOS_ACK_DELAY_MS		30		/* Delayed STS after the user reads */
#define CHAOS_PROBE_MS			5000	/* Genera: *probe-interval* */
#define CHAOS_LONELY_MS			60000	/* Genera: *long-probe-interval* */
#define CHAOS_HOST_DOWN_MS		90000	/* Genera: *host-down-interval* */
#define CHAOS_RFC_TIMEOUT_MS	20000	/* Give up on an unanswered RFC */
#define CHAOS_FINISH_TIMEOUT_MS	10000	/* Give up waiting for our EOF's ack */
#define CHAOS_ARP_RETRY_MS		500		/* Between ARP requests for one address */
#define CHAOS_ARP_REFRESH_MS	300000	/* Re-ARP a cached entry this old */

typedef void (*ChaosEmitFn) (void* ctx, const unsigned char* frame, size_t nBytes);

typedef enum
  {
	CONN_FREE = 0,
	CONN_RFC_SENT,
	CONN_OPEN,
	CONN_CLOSED						/* Finished or refused; awaiting chaos_release */
  }		ChaosConnState;

/* Why a connection left the OPEN (or RFC_SENT) state */
typedef enum
  {
	CLOSE_NONE = 0,
	CLOSE_CLS,						/* Peer sent CLS (reason in conn->reason) */
	CLOSE_LOS,						/* Peer sent LOS */
	CLOSE_ANS,						/* Peer answered a simple RFC (data in reason) */
	CLOSE_TIMEOUT,					/* RFC unanswered / host stopped responding */
	CLOSE_DONE						/* Our EOF was acknowledged and we sent CLS */
  }		ChaosCloseKind;

typedef struct
  {
	boolean present;
	unsigned char opcode;
	unsigned short num;
	unsigned short nBytes;
	unsigned short offset;			/* Receive side: bytes already consumed */
	uint64_t sentAtMs;				/* Send side: last (re)transmission */
	unsigned char data[CHAOS_MAX_DATA];
  }		ChaosPkt;

typedef struct
  {
	ChaosConnState state;
	ChaosCloseKind closeKind;
	unsigned short localIndex;
	unsigned short remoteAddr;
	unsigned short remoteIndex;
	char reason[CHAOS_MAX_DATA + 1];
	size_t reasonBytes;

	/* Send side.  sendq holds every controlled packet not yet receipted,
	   indexed by packet# modulo CHAOS_RING. */
	unsigned short sentNum;			/* pkt-num-sent: last number assigned */
	unsigned short ackedNum;		/* send-pkt-acked: peer consumed through here */
	unsigned short receiptNum;		/* Peer received through here */
	unsigned short remoteWindow;
	ChaosPkt sendq[CHAOS_RING];
	boolean eofWanted;				/* User asked to finish; EOF not yet sent */
	boolean eofSent;
	unsigned short eofNum;
	uint64_t finishStartMs;

	/* Receive side.  rcvq holds packets in (readNum, readNum + window]. */
	unsigned short readNum;			/* pkt-num-read: user consumed through here */
	unsigned short receivedNum;		/* pkt-num-received: in order through here */
	unsigned short lastAckSent;
	unsigned short localWindow;
	ChaosPkt rcvq[CHAOS_RING];
	boolean eofReceived;			/* The user has read up to the peer's EOF */
	uint64_t ackDueMs;				/* 0 = no delayed STS pending */

	uint64_t openedMs;				/* RFC transmission time */
	uint64_t lastHeardMs;
	uint64_t lastProbeMs;
  }		ChaosConn;

typedef struct
  {
	boolean valid;
	unsigned short addr;
	unsigned char mac[6];
	uint64_t learnedMs;
	uint64_t requestedMs;			/* Last ARP request we sent for it */
	boolean requested;
  }		ChaosArpEntry;

typedef struct
  {
	/* Configuration */
	unsigned short myAddr;
	unsigned char myMac[6];
	char hostName[33];				/* For STATUS */
	unsigned short localWindow;
	unsigned short initialPktNum;	/* Next RFC's packet number (tests pin it) */
	ChaosEmitFn emit;
	void* emitCtx;
	int debug;						/* Trace frames to stderr */

	ChaosConn conns[CHAOS_MAX_CONNS];
	unsigned short uniquizer;
	ChaosArpEntry arp[CHAOS_ARP_ENTRIES];

	/* Meters */
	unsigned long nFramesIn, nFramesOut, nRetransmits, nDuplicates,
				  nOverWindow, nStatusAnswered, nRfcRefused, nLosSent;
  }		ChaosCore;


/* Setup and drive */
void chaos_core_init (ChaosCore* c, unsigned short myAddr, const unsigned char myMac[6],
					  const char* hostName, ChaosEmitFn emit, void* emitCtx);
void chaos_core_input (ChaosCore* c, const unsigned char* frame, size_t nBytes,
					   uint64_t nowMs);
void chaos_core_tick (ChaosCore* c, uint64_t nowMs);
/* Milliseconds until chaos_core_tick has something to do (capped at maxMs) */
int chaos_core_next_timeout (ChaosCore* c, uint64_t nowMs, int maxMs);

/* User side of a connection.  Connection handles are small integers. */
int chaos_open (ChaosCore* c, unsigned short addr, const char* contact, size_t contactBytes,
				uint64_t nowMs);
ChaosConnState chaos_state (ChaosCore* c, int h);
ChaosConn* chaos_conn (ChaosCore* c, int h);
size_t chaos_send_room (ChaosCore* c, int h);
size_t chaos_send (ChaosCore* c, int h, const unsigned char* data, size_t nBytes,
				   uint64_t nowMs);
void chaos_finish (ChaosCore* c, int h, uint64_t nowMs);
size_t chaos_recv (ChaosCore* c, int h, unsigned char* buf, size_t max, uint64_t nowMs);
boolean chaos_recv_ready (ChaosCore* c, int h);
boolean chaos_recv_eof (ChaosCore* c, int h);
void chaos_release (ChaosCore* c, int h, const char* reason, uint64_t nowMs);

/* ARP */
boolean chaos_arp_lookup (ChaosCore* c, unsigned short addr, unsigned char mac[6]);

/* Utilities shared with the tests and the transport */
unsigned short chaos_get16 (const unsigned char* p);
void chaos_put16 (unsigned char* p, unsigned short v);
boolean chaos_seq_lt (unsigned short a, unsigned short b);
const char* chaos_opcode_name (unsigned char opcode);
void chaos_trace_frame (const char* tag, const unsigned char* frame, size_t nBytes);

#endif /* CHAOS_CORE_H */
