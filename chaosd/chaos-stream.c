/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd stream front end: bridges Unix stream sockets to core connections.
 * See chaos-stream.h for the line protocol.
 *
 * Flow control: bytes are read from a client socket only while the
 * connection's send window has room (chaos_send_room), and chaos data is
 * consumed from the core (which is what opens the PEER's window) only as
 * fast as the client drains our output buffer.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

#include "chaos-stream.h"


static void set_nonblocking (int fd)
{
  int flags = fcntl (fd, F_GETFL, 0);

	if (flags >= 0)
		fcntl (fd, F_SETFL, flags | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
	{
	  int one = 1;
		setsockopt (fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof (one));
	}
#endif
}

void stream_init (StreamServer* s, ChaosCore* core, uint64_t (*clock) (void))
{
  int i;

	memset (s, 0, sizeof (StreamServer));
	s->core = core;
	s->listenFd = -1;
	s->clock = clock;
	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
	  {
		s->clients[i].fd = -1;
		s->clients[i].conn = -1;
	  }
}

int stream_listen (StreamServer* s, const char* path)
{
  struct sockaddr_un sun;
  int fd;

	if (strlen (path) >= sizeof (sun.sun_path))
	  {
		errno = ENAMETOOLONG;
		return (-1);
	  }
	memset (&sun, 0, sizeof (sun));
	sun.sun_family = AF_UNIX;
	strlcpy (sun.sun_path, path, sizeof (sun.sun_path));

	/* A live socket means another daemon; a dead one is stale */
	fd = socket (AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0)
		return (-1);
	if (0 == connect (fd, (struct sockaddr*) &sun, sizeof (sun)))
	  {
		close (fd);
		errno = EADDRINUSE;
		return (-1);
	  }
	close (fd);
	unlink (path);

	fd = socket (AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0)
		return (-1);
	if (bind (fd, (struct sockaddr*) &sun, sizeof (sun)) < 0 || listen (fd, 16) < 0)
	  {
		int e = errno;
		close (fd);
		errno = e;
		return (-1);
	  }
	set_nonblocking (fd);
	s->listenFd = fd;
	return (fd);
}

boolean stream_add_host (StreamServer* s, const char* spec)
{
  const char* eq = strchr (spec, '=');
  char* end;
  unsigned long addr;
  StreamHost* h;

	if (NULL == eq || eq == spec || (size_t) (eq - spec) >= sizeof (h->name) ||
		s->nHosts >= STREAM_MAX_HOSTS)
		return (FALSE);
	addr = strtoul (eq + 1, &end, 8);
	if (*end != 0 || end == eq + 1 || 0 == addr || addr > 0xFFFF)
		return (FALSE);
	h = &s->hosts[s->nHosts++];
	memcpy (h->name, spec, (size_t) (eq - spec));
	h->name[eq - spec] = 0;
	h->addr = (unsigned short) addr;
	return (TRUE);
}

int stream_adopt (StreamServer* s, int fd)
{
  int i;

	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
		if (CLIENT_FREE == s->clients[i].state)
		  {
			StreamClient* k = &s->clients[i];
			memset (k, 0, sizeof (StreamClient));
			k->state = CLIENT_LINE;
			k->fd = fd;
			k->conn = -1;
			set_nonblocking (fd);
			return (i);
		  }
	return (-1);
}

int stream_active_clients (StreamServer* s)
{
  int i, n = 0;

	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
		if (s->clients[i].state != CLIENT_FREE)
			n++;
	return (n);
}


/*** Client helpers ***/

static void client_close (StreamServer* s, StreamClient* k, const char* reason,
						  uint64_t nowMs)
{
	if (k->conn >= 0)
		chaos_release (s->core, k->conn, reason, nowMs);
	if (k->fd >= 0)
		close (k->fd);
	if (s->debug)
		fprintf (stderr, "chaosd: client %d closed (%s)\n", (int) (k - s->clients), reason);
	memset (k, 0, sizeof (StreamClient));
	k->state = CLIENT_FREE;
	k->fd = -1;
	k->conn = -1;
}

static void out_compact (StreamClient* k)
{
	if (k->outOff > 0)
	  {
		memmove (k->out, k->out + k->outOff, k->outLen - k->outOff);
		k->outLen -= k->outOff;
		k->outOff = 0;
	  }
}

static void out_append (StreamClient* k, const void* data, size_t n)
{
	out_compact (k);
	if (n > STREAM_OUTBUF - k->outLen)
		n = STREAM_OUTBUF - k->outLen;
	memcpy (k->out + k->outLen, data, n);
	k->outLen += n;
}

/* A status line; the reason is made printable (Genera reasons may hold
   Lispm characters or CRs) */
static void out_line (StreamClient* k, const char* verb, const char* text, size_t n)
{
  char line[CHAOS_MAX_DATA + 32];
  size_t len, i;

	len = (size_t) snprintf (line, sizeof (line) - 2, "%s ", verb);
	for (i = 0; i < n && len < sizeof (line) - 3; i++)
	  {
		unsigned char b = (unsigned char) text[i];
		line[len++] = (char) ((b >= 0x20 && b < 0x7F) ? b : ' ');
	  }
	while (len > 0 && line[len - 1] == ' ')
		len--;
	line[len++] = '\r';
	line[len++] = '\n';
	out_append (k, line, len);
}

static void fail_client (StreamClient* k, const char* verb, const char* text)
{
	out_line (k, verb, text, strlen (text));
	k->state = CLIENT_DRAIN;
}

static boolean resolve_host (StreamServer* s, const char* name, unsigned short* addr)
{
  const char* p;
  int i;

	for (p = name; *p >= '0' && *p <= '7'; p++)
		;
	if (0 == *p && p != name)
	  {
		unsigned long a = strtoul (name, NULL, 8);
		if (0 == a || a > 0xFFFF)
			return (FALSE);
		*addr = (unsigned short) a;
		return (TRUE);
	  }
	for (i = 0; i < s->nHosts; i++)
		if (0 == strcasecmp (s->hosts[i].name, name))
		  {
			*addr = s->hosts[i].addr;
			return (TRUE);
		  }
	return (FALSE);
}

/* The client's request line is complete (in k->line, terminator removed) */
static void handle_request (StreamServer* s, StreamClient* k, uint64_t nowMs)
{
  char* p = k->line;
  char* host;
  char* contact;
  char* end;
  unsigned short addr;
  char msg[128];

	while (*p == ' ' || *p == '\t') p++;
	if (strncasecmp (p, "RFC", 3) != 0 || (p[3] != ' ' && p[3] != '\t'))
	  {
		fail_client (k, "LOS", "Only RFC <host> <contact> [args] is supported");
		return;
	  }
	p += 3;
	while (*p == ' ' || *p == '\t') p++;
	host = p;
	while (*p != 0 && *p != ' ' && *p != '\t') p++;
	if (*p != 0)
		*p++ = 0;
	while (*p == ' ' || *p == '\t') p++;
	contact = p;
	end = contact + strlen (contact);
	while (end > contact && (end[-1] == ' ' || end[-1] == '\t'))
		*--end = 0;
	if (0 == host[0] || 0 == contact[0])
	  {
		fail_client (k, "LOS", "Usage: RFC <host> <contact> [args]");
		return;
	  }
	if (!resolve_host (s, host, &addr))
	  {
		snprintf (msg, sizeof (msg), "Unknown host %s", host);
		fail_client (k, "LOS", msg);
		return;
	  }
	if (addr == s->core->myAddr)
	  {
		fail_client (k, "LOS", "That is chaosd's own address");
		return;
	  }
	k->addr = addr;
	k->conn = chaos_open (s->core, addr, contact, strlen (contact), nowMs);
	if (k->conn < 0)
	  {
		fail_client (k, "LOS", "Too many connections, or contact too long");
		return;
	  }
	if (s->debug)
		fprintf (stderr, "chaosd: client %d: RFC %o \"%s\"\n",
				 (int) (k - s->clients), addr, contact);
	k->state = CLIENT_WAIT_OPN;
}

/* Take bytes read from the socket in the LINE state */
static void line_input (StreamServer* s, StreamClient* k, const unsigned char* buf,
						size_t n, uint64_t nowMs)
{
  size_t i;

	for (i = 0; i < n; i++)
	  {
		if (buf[i] == '\r' || buf[i] == '\n')
		  {
			k->line[k->lineLen] = 0;
			k->skipLf = (buf[i] == '\r');
			i++;
			if (i < n && k->skipLf && buf[i] == '\n')
			  {
				i++;
				k->skipLf = FALSE;
			  }
			/* Anything after the line is stream data */
			if (i < n)
			  {
				size_t rest = n - i;
				if (rest > STREAM_INBUF)
					rest = STREAM_INBUF;
				memcpy (k->in, buf + i, rest);
				k->inLen = rest;
				k->skipLf = FALSE;
			  }
			handle_request (s, k, nowMs);
			return;
		  }
		if (k->lineLen >= STREAM_LINE_MAX - 1)
		  {
			fail_client (k, "LOS", "Request line too long");
			return;
		  }
		k->line[k->lineLen++] = (char) buf[i];
	  }
}

/* Readable socket */
static void client_read (StreamServer* s, StreamClient* k, uint64_t nowMs)
{
  unsigned char buf[STREAM_INBUF];
  size_t want;
  ssize_t n;

	if (CLIENT_LINE == k->state)
		want = 256;
	else
		want = STREAM_INBUF - k->inLen;
	if (0 == want)
		return;
	n = read (k->fd, buf, want);
	if (n < 0)
	  {
		if (EAGAIN == errno || EINTR == errno)
			return;
		client_close (s, k, "Connection aborted by user", nowMs);
		return;
	  }
	if (0 == n)
	  {
		if (CLIENT_LINE == k->state || CLIENT_WAIT_OPN == k->state)
			client_close (s, k, "Connection aborted by user", nowMs);
		else
			k->sockEof = TRUE;
		return;
	  }
	if (CLIENT_LINE == k->state)
	  {
		line_input (s, k, buf, (size_t) n, nowMs);
		return;
	  }
	if (k->skipLf)
	  {
		k->skipLf = FALSE;
		if (buf[0] == '\n')
		  {
			memmove (buf, buf + 1, (size_t) (n - 1));
			n--;
		  }
	  }
	memcpy (k->in + k->inLen, buf, (size_t) n);
	k->inLen += (size_t) n;
}

/* Writable socket (or just try) */
static boolean client_write (StreamServer* s, StreamClient* k, uint64_t nowMs)
{
	while (k->outOff < k->outLen)
	  {
		ssize_t n = write (k->fd, k->out + k->outOff, k->outLen - k->outOff);
		if (n < 0)
		  {
			if (EAGAIN == errno || EINTR == errno)
				return (TRUE);
			client_close (s, k, "Connection closed by user", nowMs);
			return (FALSE);
		  }
		k->outOff += (size_t) n;
	  }
	k->outOff = k->outLen = 0;
	return (TRUE);
}

/* Advance one client's state machine */
static void client_service (StreamServer* s, StreamClient* k, uint64_t nowMs)
{
  ChaosConn* conn;

	switch (k->state)
	  {
	  case CLIENT_WAIT_OPN:
		conn = chaos_conn (s->core, k->conn);
		if (NULL == conn)
		  {
			fail_client (k, "LOS", "Connection vanished");
			break;
		  }
		if (CONN_OPEN == conn->state)
		  {
			char line[64];
			int n = snprintf (line, sizeof (line), "OPN Connection to host %o\r\n", k->addr);
			out_append (k, line, (size_t) n);
			k->state = CLIENT_STREAM;
		  }
		else if (CONN_CLOSED == conn->state)
		  {
			switch (conn->closeKind)
			  {
			  case CLOSE_CLS:
				out_line (k, "CLS", conn->reason, conn->reasonBytes);
				break;
			  case CLOSE_ANS:
				{
				  char line[32];
				  int n = snprintf (line, sizeof (line), "ANS %zu\r\n", conn->reasonBytes);
					out_append (k, line, (size_t) n);
					out_append (k, conn->reason, conn->reasonBytes);
				}
				break;
			  case CLOSE_TIMEOUT:
				{
				  char line[CHAOS_MAX_DATA + 32];
				  int n = snprintf (line, sizeof (line), "Timed out: %s", conn->reason);
					out_line (k, "LOS", line, (size_t) n);
				}
				break;
			  default:
				out_line (k, "LOS", conn->reason, conn->reasonBytes);
				break;
			  }
			chaos_release (s->core, k->conn, "", nowMs);
			k->conn = -1;
			k->state = CLIENT_DRAIN;
			break;
		  }
		else
			break;
		/* Opened: fall into the stream case to push early data */
		/* FALLTHROUGH */

	  case CLIENT_STREAM:
		conn = chaos_conn (s->core, k->conn);
		if (NULL == conn)
		  {
			k->state = CLIENT_DRAIN;
			break;
		  }
		/* Socket -> chaos */
		if (k->inLen > 0 && CONN_OPEN == conn->state)
		  {
			size_t n = chaos_send (s->core, k->conn, k->in, k->inLen, nowMs);
			if (n > 0)
			  {
				memmove (k->in, k->in + n, k->inLen - n);
				k->inLen -= n;
			  }
		  }
		if (k->sockEof && 0 == k->inLen && !k->finished && CONN_OPEN == conn->state)
		  {
			chaos_finish (s->core, k->conn, nowMs);
			k->finished = TRUE;
		  }
		/* Chaos -> socket */
		out_compact (k);
		if (k->outLen < STREAM_OUTBUF)
			k->outLen += chaos_recv (s->core, k->conn, k->out + k->outLen,
									 STREAM_OUTBUF - k->outLen, nowMs);
		if (!client_write (s, k, nowMs))
			return;
		if (chaos_recv_eof (s->core, k->conn) && 0 == k->outLen && !k->wrShut)
		  {
			shutdown (k->fd, SHUT_WR);
			k->wrShut = TRUE;
		  }
		if (CONN_CLOSED == conn->state && !chaos_recv_ready (s->core, k->conn) &&
			0 == k->outLen)
		  {
			if (s->debug && conn->closeKind != CLOSE_DONE)
				fprintf (stderr, "chaosd: client %d: peer closed: %.*s\n",
						 (int) (k - s->clients), (int) conn->reasonBytes, conn->reason);
			client_close (s, k, "Connection closed", nowMs);
			return;
		  }
		break;

	  default:
		break;
	  }

	if (CLIENT_DRAIN == k->state)
	  {
		if (!client_write (s, k, nowMs))
			return;
		if (0 == k->outLen)
			client_close (s, k, "Request failed", nowMs);
	  }
}

void stream_service (StreamServer* s, uint64_t nowMs)
{
  int i;

	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
		if (s->clients[i].state != CLIENT_FREE)
			client_service (s, &s->clients[i], nowMs);
}

boolean stream_step (StreamServer* s, int extraFd, int timeoutMs)
{
  struct pollfd pfd[STREAM_MAX_CLIENTS + 2];
  int map[STREAM_MAX_CLIENTS + 2];
  int n = 0, i, rc;
  int listenSlot = -1, extraSlot = -1;
  boolean extraReady = FALSE;
  uint64_t nowMs;

	if (s->listenFd >= 0)
	  {
		listenSlot = n;
		pfd[n].fd = s->listenFd;
		pfd[n].events = POLLIN;
		map[n++] = -1;
	  }
	if (extraFd >= 0)
	  {
		extraSlot = n;
		pfd[n].fd = extraFd;
		pfd[n].events = POLLIN;
		map[n++] = -1;
	  }
	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
	  {
		StreamClient* k = &s->clients[i];
		short events = 0;
		if (CLIENT_FREE == k->state)
			continue;
		switch (k->state)
		  {
		  case CLIENT_LINE:
			events |= POLLIN;
			break;
		  case CLIENT_WAIT_OPN:
			if (k->inLen < STREAM_INBUF)
				events |= POLLIN;
			break;
		  case CLIENT_STREAM:
			if (!k->sockEof && 0 == k->inLen && chaos_send_room (s->core, k->conn) > 0)
				events |= POLLIN;
			break;
		  default:
			break;
		  }
		if (k->outLen > k->outOff)
			events |= POLLOUT;
		/* Excluded while it wants nothing, so a hung-up peer can't spin us */
		pfd[n].fd = events ? k->fd : -1;
		pfd[n].events = events;
		map[n++] = i;
	  }

	rc = poll (pfd, (nfds_t) n, timeoutMs);
	if (rc < 0)
		return (FALSE);
	nowMs = (*s->clock) ();

	if (extraSlot >= 0 && (pfd[extraSlot].revents & (POLLIN | POLLHUP | POLLERR)))
		extraReady = TRUE;

	for (i = 0; i < n; i++)
	  {
		StreamClient* k;
		if (map[i] < 0 || 0 == pfd[i].revents || pfd[i].fd < 0)
			continue;
		k = &s->clients[map[i]];
		if (CLIENT_FREE == k->state)
			continue;
		if ((pfd[i].events & POLLOUT) && (pfd[i].revents & (POLLOUT | POLLHUP | POLLERR)))
			if (!client_write (s, k, nowMs))
				continue;
		if (pfd[i].revents & (POLLIN | POLLHUP | POLLERR))
		  {
			if (pfd[i].events & POLLIN)
				client_read (s, k, nowMs);
			else if (!(pfd[i].events & POLLOUT) || (pfd[i].revents & POLLERR))
				client_close (s, k, "Connection aborted by user", nowMs);
		  }
	  }

	if (listenSlot >= 0 && (pfd[listenSlot].revents & POLLIN))
	  {
		int fd;
		while ((fd = accept (s->listenFd, NULL, NULL)) >= 0)
		  {
			if (stream_adopt (s, fd) < 0)
			  {
				static const char busy[] = "LOS Too many clients\r\n";
				(void) !write (fd, busy, sizeof (busy) - 1);
				close (fd);
			  }
			else if (s->debug)
				fprintf (stderr, "chaosd: client connected\n");
		  }
	  }

	stream_service (s, nowMs);
	return (extraReady);
}

void stream_shutdown (StreamServer* s, uint64_t nowMs)
{
  int i;

	for (i = 0; i < STREAM_MAX_CLIENTS; i++)
		if (s->clients[i].state != CLIENT_FREE)
			client_close (s, &s->clients[i], "chaosd shutting down", nowMs);
	if (s->listenFd >= 0)
	  {
		close (s->listenFd);
		s->listenFd = -1;
	  }
}
