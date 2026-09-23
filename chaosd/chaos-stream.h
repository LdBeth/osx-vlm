/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd stream front end: the /tmp/chaos_stream Unix socket.
 *
 * Line protocol (what supdup's chaos.c speaks):
 *   client:  RFC <host> <contact> [args...]\r\n
 *   daemon:  OPN Connection to host <octal addr>\r\n     success; the socket
 *                                                        is now a raw stream
 *            CLS <reason>\r\n | LOS <reason>\r\n         refused / failed
 *            ANS <n>\r\n followed by n bytes             simple-protocol answer
 * then the daemon closes the socket after any failure or ANS.
 */

#ifndef CHAOS_STREAM_H
#define CHAOS_STREAM_H

#include <sys/types.h>
#include "chaos-core.h"

#define STREAM_MAX_CLIENTS	CHAOS_MAX_CONNS
#define STREAM_MAX_HOSTS	32
#define STREAM_LINE_MAX		600
#define STREAM_OUTBUF		8192
#define STREAM_INBUF		4096

typedef enum
  {
	CLIENT_FREE = 0,
	CLIENT_LINE,					/* Reading the RFC line */
	CLIENT_WAIT_OPN,				/* RFC sent, awaiting OPN */
	CLIENT_STREAM,					/* Raw byte stream */
	CLIENT_DRAIN					/* Flush outbuf, then close */
  }		ClientState;

typedef struct
  {
	ClientState state;
	int fd;
	int conn;						/* Core connection handle, -1 = none */
	unsigned short addr;
	char line[STREAM_LINE_MAX];
	size_t lineLen;
	unsigned char in[STREAM_INBUF];	/* Socket -> chaos, not yet sent */
	size_t inLen;
	unsigned char out[STREAM_OUTBUF];	/* Chaos -> socket, not yet written */
	size_t outOff, outLen;
	boolean sockEof;				/* Client shut its write side */
	boolean finished;				/* chaos_finish issued */
	boolean wrShut;					/* We shut the socket's write side */
	boolean skipLf;					/* Swallow the LF of the RFC line's CRLF */
  }		StreamClient;

typedef struct
  {
	char name[64];
	unsigned short addr;
  }		StreamHost;

typedef struct
  {
	ChaosCore* core;
	int listenFd;					/* -1 when only adopted fds are used */
	StreamClient clients[STREAM_MAX_CLIENTS];
	StreamHost hosts[STREAM_MAX_HOSTS];
	int nHosts;
	int debug;
	uint64_t (*clock) (void);		/* Milliseconds; monotonic */
  }		StreamServer;

void stream_init (StreamServer* s, ChaosCore* core, uint64_t (*clock) (void));
int stream_listen (StreamServer* s, const char* path);
boolean stream_add_host (StreamServer* s, const char* spec);	/* "name=octal" */
int stream_adopt (StreamServer* s, int fd);

/* One iteration: poll the listen socket, the clients and extraFd (may be
   -1) for up to timeoutMs, service everything, and return TRUE if extraFd
   became readable.  Returns FALSE with errno EINTR if a signal arrived. */
boolean stream_step (StreamServer* s, int extraFd, int timeoutMs);
/* Move data between clients and the core without polling (after input) */
void stream_service (StreamServer* s, uint64_t nowMs);
void stream_shutdown (StreamServer* s, uint64_t nowMs);
int stream_active_clients (StreamServer* s);

#endif /* CHAOS_STREAM_H */
