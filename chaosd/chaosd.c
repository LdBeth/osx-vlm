/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd -- a host-side Chaosnet station for the Portable Genera VLM.
 *
 * Host programs (first of all supdup -C) connect to the Unix socket
 * /tmp/chaos_stream, send "RFC <host> <contact>" and get a byte stream to a
 * Chaos connection.  The Chaos side is a vmnet station of our own on the
 * VLM's host-only network, speaking Chaos-over-Ethernet -- Genera has no
 * Chaos-over-IP.  See README.md.
 *
 *   sudo ./chaosd [-d] [-a addr] [-s socket] [-N subnet] [-S] [-n name]
 *                 [-w window] [-H name=addr]...
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/stat.h>

#include "chaos-core.h"
#include "chaos-stream.h"
#include "vmnet-transport.h"

#define DEFAULT_SOCKET	"/tmp/chaos_stream"
#define DEFAULT_ADDR	0402
#define DEFAULT_SUBNET	"192.168.2.0"

static volatile sig_atomic_t stopRequested;

static void on_signal (int sig)
{
	(void) sig;
	stopRequested = 1;
}

static uint64_t now_ms (void)
{
  struct timespec ts;

	clock_gettime (CLOCK_MONOTONIC, &ts);
	return ((uint64_t) ts.tv_sec * 1000 + (uint64_t) (ts.tv_nsec / 1000000L));
}

static void emit_vmnet (void* ctx, const unsigned char* frame, size_t nBytes)
{
	if (vmnet_transport_write ((VmnetTransport*) ctx, frame, nBytes) < 0)
		fprintf (stderr, "chaosd: vmnet_write failed (%zu bytes)\n", nBytes);
}

static void usage (const char* me)
{
	fprintf (stderr,
			 "usage: sudo %s [-d] [-a addr] [-s socket] [-N subnet] [-S] [-n name]\n"
			 "              [-w window] [-H name=addr]... [-R]\n"
			 "  -a addr     our Chaos address, octal (default %o)\n"
			 "  -s socket   stream socket path (default %s)\n"
			 "  -N subnet   the VLM's IPv4 /24, as in ~/.VLM genera.network\n"
			 "              (default %s; only picks the vmnet network)\n"
			 "  -S          the VLM uses mode=shared, not mode=private\n"
			 "  -n name     host name returned to STATUS (default: short hostname)\n"
			 "  -w window   receive window in packets (default %d, max %d)\n"
			 "  -H n=addr   host name for RFC lines, e.g. -H genera=401 (repeatable)\n"
			 "  -d          trace every Chaos and chaos-ARP frame on stderr\n"
			 "  -R          keep root (don't seteuid to SUDO_UID after vmnet is up)\n",
			 me, DEFAULT_ADDR, DEFAULT_SOCKET, DEFAULT_SUBNET,
			 CHAOS_DEFAULT_WINDOW, CHAOS_RING / 2);
	exit (2);
}

int main (int argc, char** argv)
{
  static ChaosCore core;
  static StreamServer server;
  unsigned long addr = DEFAULT_ADDR;
  const char* socketPath = DEFAULT_SOCKET;
  const char* subnetString = DEFAULT_SUBNET;
  char hostName[64] = "";
  int window = CHAOS_DEFAULT_WINDOW;
  int shared = 0, debug = 0, keepRoot = 0;
  char* hostSpecs[STREAM_MAX_HOSTS];
  int nHostSpecs = 0;
  struct in_addr subnet;
  VmnetTransport* vmnet;
  char err[256];
  uid_t uid = 0;
  gid_t gid = 0;
  const char* sudoUid = getenv ("SUDO_UID");
  const char* sudoGid = getenv ("SUDO_GID");
  struct sigaction sa;
  const unsigned char* mac;
  int opt, i;

	while ((opt = getopt (argc, argv, "a:s:N:Sn:w:H:dRh")) != -1)
		switch (opt)
		  {
		  case 'a':
			{
			  char* end;
				addr = strtoul (optarg, &end, 8);
				if (*end != 0 || 0 == addr || addr > 0xFFFF)
				  {
					fprintf (stderr, "chaosd: -a wants an octal Chaos address\n");
					return (2);
				  }
			}
			break;
		  case 's': socketPath = optarg; break;
		  case 'N': subnetString = optarg; break;
		  case 'S': shared = 1; break;
		  case 'n': strlcpy (hostName, optarg, sizeof (hostName)); break;
		  case 'w':
			window = atoi (optarg);
			if (window < 1 || window > CHAOS_RING / 2)
			  {
				fprintf (stderr, "chaosd: -w wants 1..%d\n", CHAOS_RING / 2);
				return (2);
			  }
			break;
		  case 'H':
			if (nHostSpecs >= STREAM_MAX_HOSTS)
			  {
				fprintf (stderr, "chaosd: too many -H options\n");
				return (2);
			  }
			hostSpecs[nHostSpecs++] = optarg;
			break;
		  case 'd': debug = 1; break;
		  case 'R': keepRoot = 1; break;
		  default: usage (argv[0]);
		  }
	if (optind != argc)
		usage (argv[0]);
	if (inet_pton (AF_INET, subnetString, &subnet) != 1)
	  {
		fprintf (stderr, "chaosd: -N wants a dotted IPv4 address\n");
		return (2);
	  }
	if (0 == hostName[0])
	  {
		char* dot;
		if (gethostname (hostName, sizeof (hostName)) < 0)
			strlcpy (hostName, "CHAOSD", sizeof (hostName));
		if ((dot = strchr (hostName, '.')) != NULL)
			*dot = 0;
		for (i = 0; hostName[i]; i++)
			hostName[i] = (char) toupper ((unsigned char) hostName[i]);
	  }

	if (geteuid () != 0)
	  {
		fprintf (stderr, "chaosd: vmnet needs root -- run: sudo %s\n", argv[0]);
		return (1);
	  }
	if (sudoUid != NULL && sudoGid != NULL)
	  {
		uid = (uid_t) strtoul (sudoUid, NULL, 10);
		gid = (gid_t) strtoul (sudoGid, NULL, 10);
	  }

	/* The interface first: without it there is nothing to serve */
	vmnet = vmnet_transport_start (ntohl (subnet.s_addr), shared, err, sizeof (err));
	if (NULL == vmnet)
	  {
		fprintf (stderr, "chaosd: %s\n", err);
		return (1);
	  }
	mac = vmnet_transport_mac (vmnet);

	chaos_core_init (&core, (unsigned short) addr, mac, hostName, &emit_vmnet, vmnet);
	core.localWindow = (unsigned short) window;
	core.initialPktNum = (unsigned short) (now_ms () & 0xFF00);
	core.debug = debug;

	stream_init (&server, &core, &now_ms);
	server.debug = debug;
	for (i = 0; i < nHostSpecs; i++)
		if (!stream_add_host (&server, hostSpecs[i]))
		  {
			fprintf (stderr, "chaosd: bad -H %s (want name=octal)\n", hostSpecs[i]);
			vmnet_transport_stop (vmnet);
			return (2);
		  }

	if (stream_listen (&server, socketPath) < 0)
	  {
		fprintf (stderr, "chaosd: %s: %s%s\n", socketPath, strerror (errno),
				 (EADDRINUSE == errno) ? " (another chaosd is running)" : "");
		vmnet_transport_stop (vmnet);
		return (1);
	  }
	/* The socket belongs to the user who ran sudo, mode 0660 */
	if (uid != 0 && chown (socketPath, uid, gid) < 0)
		fprintf (stderr, "chaosd: chown %s: %s\n", socketPath, strerror (errno));
	chmod (socketPath, (uid != 0) ? 0660 : 0666);

	/* Drop privileges, keeping the saved uid for vmnet_stop_interface */
	if (uid != 0 && !keepRoot)
	  {
		if (setegid (gid) < 0 || seteuid (uid) < 0)
			fprintf (stderr, "chaosd: could not drop privileges: %s\n", strerror (errno));
	  }

	memset (&sa, 0, sizeof (sa));
	sa.sa_handler = &on_signal;
	sigemptyset (&sa.sa_mask);
	sa.sa_flags = 0;						/* No SA_RESTART: poll must return */
	sigaction (SIGINT, &sa, NULL);
	sigaction (SIGTERM, &sa, NULL);
	signal (SIGPIPE, SIG_IGN);

	printf ("chaosd: Chaos address %lo (subnet %lo host %lo), MAC %02x:%02x:%02x:%02x:%02x:%02x\n",
			addr, addr >> 8, addr & 0xFF, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
	printf ("chaosd: vmnet %s mode on %s/24, network %s\n",
			shared ? "shared" : "host", subnetString, vmnet_transport_network_id (vmnet));
	printf ("chaosd: STATUS name %s, window %d; listening on %s\n", hostName, window, socketPath);
	fflush (stdout);

	while (!stopRequested)
	  {
		uint64_t now = now_ms ();
		int timeout = chaos_core_next_timeout (&core, now, 50);
		boolean frames = stream_step (&server, vmnet_transport_notify_fd (vmnet), timeout);

		if (stopRequested)
			break;
		now = now_ms ();
		if (frames)
		  {
			unsigned char buf[2048];
			size_t n;
			vmnet_transport_clear_notify (vmnet);
			while ((n = vmnet_transport_read (vmnet, buf, sizeof (buf))) > 0)
				chaos_core_input (&core, buf, n, now);
		  }
		chaos_core_tick (&core, now);
		stream_service (&server, now);
	  }

	printf ("\nchaosd: shutting down (%lu frames in, %lu out, %lu retransmits)\n",
			core.nFramesIn, core.nFramesOut, core.nRetransmits);
	stream_shutdown (&server, now_ms ());	/* CLS to every open connection */
	unlink (socketPath);
	if (uid != 0 && !keepRoot)
	  {
		(void) !seteuid (0);
		(void) !setegid (0);
	  }
	vmnet_transport_stop (vmnet);
	return (0);
}
