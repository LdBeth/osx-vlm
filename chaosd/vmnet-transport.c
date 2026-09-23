/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd vmnet transport.
 *
 * The VLM (VLM-12.10.3 life-support/network-darwin.c) starts its interface
 * in host mode ("mode=private") or shared mode with start address
 * subnet.1, end subnet.254, mask 255.255.255.0 and a deterministic
 * network identifier (see netid.c).  We start a second interface with the
 * identical description, so vmnet puts us on the same L2 segment as a
 * separate station with a vmnet-allocated MAC.  Chaos frames (0x0804) and
 * chaos-ARP pass between vmnet stations untouched (proved by
 * port-log/vmnet-chaos-probe.c).
 *
 * vmnet delivers "packets available" events on a dispatch queue; we turn
 * those into a byte on a pipe so the daemon's single poll() loop wakes,
 * and do every vmnet_read / vmnet_write from the main thread.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <dispatch/dispatch.h>
#include <vmnet/vmnet.h>
#include <xpc/xpc.h>

#include "vmnet-transport.h"
#include "netid.h"

#define ETH_MIN_FRAME 60

struct VmnetTransport
  {
	interface_ref iface;
	dispatch_queue_t queue;
	int notify[2];
	unsigned char mac[6];
	char networkId[37];
	uint64_t maxPacket;
  };

static void set_nonblocking (int fd)
{
  int flags = fcntl (fd, F_GETFL, 0);

	if (flags >= 0)
		fcntl (fd, F_SETFL, flags | O_NONBLOCK);
}

VmnetTransport* vmnet_transport_start (uint32_t subnetHostOrder, int shared,
									   char* err, size_t errSize)
{
  VmnetTransport* t = calloc (1, sizeof (VmnetTransport));
  xpc_object_t desc;
  dispatch_semaphore_t startSem;
  __block vmnet_return_t startStatus = VMNET_FAILURE;
  char macString[64] = "";
  char* macp = macString;
  __block uint64_t maxPacket = 1514;
  char startAddr[INET_ADDRSTRLEN], endAddr[INET_ADDRSTRLEN];
  struct in_addr a;
  int notifyWrite;

	if (NULL == t)
	  {
		snprintf (err, errSize, "out of memory");
		return (NULL);
	  }
	if (pipe (t->notify) < 0)
	  {
		snprintf (err, errSize, "pipe: %s", strerror (errno));
		free (t);
		return (NULL);
	  }
	set_nonblocking (t->notify[0]);
	set_nonblocking (t->notify[1]);
	notifyWrite = t->notify[1];

	a.s_addr = htonl ((subnetHostOrder & 0xFFFFFF00) | 1);
	inet_ntop (AF_INET, &a, startAddr, sizeof (startAddr));
	a.s_addr = htonl ((subnetHostOrder & 0xFFFFFF00) | 254);
	inet_ntop (AF_INET, &a, endAddr, sizeof (endAddr));
	vlm_network_identifier (subnetHostOrder & 0xFFFFFF00, t->networkId);

	desc = xpc_dictionary_create (NULL, NULL, 0);
	xpc_dictionary_set_uint64 (desc, vmnet_operation_mode_key,
							   shared ? VMNET_SHARED_MODE : VMNET_HOST_MODE);
	xpc_dictionary_set_bool (desc, vmnet_allocate_mac_address_key, true);
	xpc_dictionary_set_string (desc, vmnet_start_address_key, startAddr);
	xpc_dictionary_set_string (desc, vmnet_end_address_key, endAddr);
	xpc_dictionary_set_string (desc, vmnet_subnet_mask_key, "255.255.255.0");
	xpc_dictionary_set_string (desc, vmnet_network_identifier_key, t->networkId);

	t->queue = dispatch_queue_create ("chaosd.vmnet", DISPATCH_QUEUE_SERIAL);
	startSem = dispatch_semaphore_create (0);
	t->iface = vmnet_start_interface (desc, t->queue,
		^(vmnet_return_t status, xpc_object_t param)
		{
			startStatus = status;
			if (VMNET_SUCCESS == status && param != NULL)
			  {
				const char* m = xpc_dictionary_get_string (param, vmnet_mac_address_key);
				if (m != NULL)
					strlcpy (macp, m, 64);
				maxPacket = xpc_dictionary_get_uint64 (param, vmnet_max_packet_size_key);
			  }
			dispatch_semaphore_signal (startSem);
		});
	xpc_release (desc);
	if (NULL == t->iface)
	  {
		snprintf (err, errSize, "vmnet_start_interface failed (are you root? run with sudo)");
		goto fail;
	  }
	dispatch_semaphore_wait (startSem, DISPATCH_TIME_FOREVER);
	if (startStatus != VMNET_SUCCESS)
	  {
		snprintf (err, errSize, "vmnet_start_interface failed with status %d%s",
				  (int) startStatus,
				  (VMNET_FAILURE == startStatus) ? " (are you root? run with sudo)" : "");
		t->iface = NULL;
		goto fail;
	  }
	{
	  unsigned int b[6];
	  int i;
		if (6 != sscanf (macString, "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]))
		  {
			snprintf (err, errSize, "vmnet returned no MAC address");
			goto fail;
		  }
		for (i = 0; i < 6; i++)
			t->mac[i] = (unsigned char) b[i];
	}
	t->maxPacket = maxPacket ? maxPacket : 1514;

	if (vmnet_interface_set_event_callback (t->iface, VMNET_INTERFACE_PACKETS_AVAILABLE, t->queue,
		^(interface_event_t mask, xpc_object_t event)
		{
		  char b = 1;
			(void) mask; (void) event;
			(void) !write (notifyWrite, &b, 1);
		}) != VMNET_SUCCESS)
	  {
		snprintf (err, errSize, "vmnet_interface_set_event_callback failed");
		goto fail;
	  }
	return (t);

  fail:
	if (t->iface != NULL)
		vmnet_transport_stop (t);
	else
	  {
		close (t->notify[0]);
		close (t->notify[1]);
		free (t);
	  }
	return (NULL);
}

const unsigned char* vmnet_transport_mac (VmnetTransport* t)
{
	return (t->mac);
}

const char* vmnet_transport_network_id (VmnetTransport* t)
{
	return (t->networkId);
}

int vmnet_transport_notify_fd (VmnetTransport* t)
{
	return (t->notify[0]);
}

void vmnet_transport_clear_notify (VmnetTransport* t)
{
  char buf[64];

	while (read (t->notify[0], buf, sizeof (buf)) > 0)
		;
}

size_t vmnet_transport_read (VmnetTransport* t, unsigned char* buf, size_t max)
{
  struct vmpktdesc packet;
  struct iovec iov;
  int count = 1;

	iov.iov_base = buf;
	iov.iov_len = max;
	packet.vm_pkt_size = max;
	packet.vm_pkt_iov = &iov;
	packet.vm_pkt_iovcnt = 1;
	packet.vm_flags = 0;
	if (vmnet_read (t->iface, &packet, &count) != VMNET_SUCCESS || count < 1)
		return (0);
	return (packet.vm_pkt_size);
}

int vmnet_transport_write (VmnetTransport* t, const unsigned char* frame, size_t nBytes)
{
  struct vmpktdesc packet;
  struct iovec iov;
  unsigned char padded[ETH_MIN_FRAME];
  int count = 1;

	if (nBytes < ETH_MIN_FRAME)
	  {
		memset (padded, 0, sizeof (padded));
		memcpy (padded, frame, nBytes);
		frame = padded;
		nBytes = ETH_MIN_FRAME;
	  }
	iov.iov_base = (void*) frame;
	iov.iov_len = nBytes;
	packet.vm_pkt_size = nBytes;
	packet.vm_pkt_iov = &iov;
	packet.vm_pkt_iovcnt = 1;
	packet.vm_flags = 0;
	if (vmnet_write (t->iface, &packet, &count) != VMNET_SUCCESS || count < 1)
		return (-1);
	return (0);
}

void vmnet_transport_stop (VmnetTransport* t)
{
  dispatch_semaphore_t done = dispatch_semaphore_create (0);

	if (t->iface != NULL)
	  {
		vmnet_interface_set_event_callback (t->iface, VMNET_INTERFACE_PACKETS_AVAILABLE,
											NULL, NULL);
		if (VMNET_SUCCESS == vmnet_stop_interface (t->iface, t->queue,
												   ^(vmnet_return_t status)
												   {
													   (void) status;
													   dispatch_semaphore_signal (done);
												   }))
			dispatch_semaphore_wait (done, dispatch_time (DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
		t->iface = NULL;
	  }
	close (t->notify[0]);
	close (t->notify[1]);
	free (t);
}
