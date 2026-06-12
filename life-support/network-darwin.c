/* -*- Mode: C; Tab-Width: 4 -*- */

/* VLM Network Life Support for macOS (Darwin), arm64.
 *
 * Genera presents a Layer-2 Ethernet NIC: it builds and consumes whole
 * Ethernet frames (ETHERTYPE_IP and ETHERTYPE_CHAOS).  On Apple Silicon
 * the host has no raw L2 fabric we can attach to (Wi-Fi won't carry a
 * foreign source MAC, and there is no native tap device), so we use
 * Apple's vmnet.framework -- a kext-free virtual L2 NIC with its own MAC.
 *
 * This file is staged.  When USE_VMNET is NOT defined it only populates
 * the embedded channel structure and runs the queues as a sink (no real
 * I/O, no root) -- enough to let Genera's network/namespace init bind
 * NET:*EMB-HOST* and finish booting.  When USE_VMNET is defined the
 * transmitter calls vmnet_write() and a receiver thread drains
 * vmnet_read() into the host->guest queue.  vmnet's async, dispatch-queue
 * event callback is bridged to the existing receiver-thread model with a
 * dispatch semaphore.
 *
 * vmnet shared mode requires root; run genera under sudo when USE_VMNET.
 */

#include <limits.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
#include <stdint.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <net/ethernet.h>

/* vmnet.h drags in CoreFoundation/<MacTypes.h>, which typedefs Boolean.  It
   MUST precede the project headers: world_tools.h -> ivoryrep.h also typedefs
   Boolean, and only guards against it once __MACTYPES__ (set by MacTypes.h) is
   defined.  Including vmnet first lets MacTypes win and ivoryrep stand down. */
#ifdef USE_VMNET
#include <vmnet/vmnet.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include <uuid/uuid.h>
#endif

#include "life_types.h"
#include "embed.h"
#include "VLM_configuration.h"
#include "life_prototypes.h"
#include "utilities.h"
#include "FEPComm.h"
#include "memory.h"

#ifndef ETHERTYPE_CHAOS
#define ETHERTYPE_CHAOS 0x0804
#endif

/* macOS <net/ethernet.h> spells these ETHER_ADDR_LEN / (ETHER_MIN_LEN - FCS);
   provide the Linux names the shared frame-handling logic uses. */
#ifndef ETH_ALEN
#define ETH_ALEN 6				/* Octets in one Ethernet address */
#endif
#ifndef ETH_ZLEN
#define ETH_ZLEN 60				/* Min Ethernet frame, sans 4-byte FCS */
#endif

/* Darwin-local helpers, named to avoid clashing with the Linux-shaped
   InitializeNetChannel/TerminateNetChannel prototypes in life_prototypes.h. */
static void InitializeNetChannelDarwin (NetworkInterface* interface, int unitNumber);
static void TerminateNetChannelDarwin (EmbNetChannel* netChannel);

/* Defined below; not prototyped in the life-support headers. */
void NetworkChannelReceiver (pthread_addr_t argument);

#ifdef USE_VMNET
static void StartVMNetInterface (EmbNetChannel* p, NetworkInterface* interface,
								 unsigned char mac[6]);
#endif


/* Create the network channels */

void InitializeNetworkChannels (VLMConfig* config)
{
  int i;

	printf ("InitializeNetworkChannels() [vmnet/darwin]\n");

	for (i = 0; i < MaxNetworkInterfaces; i++)
		if (config->interfaces[i].present)
			InitializeNetChannelDarwin (&config->interfaces[i], i);
}


/* Create a single network channel */

static void InitializeNetChannelDarwin (NetworkInterface* interface, int unitNumber)
{
  EmbPtr cp = EmbCommAreaAlloc (sizeof (EmbNetChannel));
  register EmbNetChannel* p = (EmbNetChannel*) HostPointer (cp);
  NetworkInterface* pInterface;
  unsigned char mac[6];
  char addressAsString[_POSIX_ARG_MAX];
  boolean firstInterface;

	p->type = EmbNetworkChannelType;
	p->unit = unitNumber;
	p->receiverThreadSetup = FALSE;				/* Needed before linking into channel list */
	p->receiverStop = 0;
	p->next = EmbCommAreaPtr->channel_table;	/* Link into the channel list */
	EmbCommAreaPtr->channel_table = cp;

	/* Interface name (1st/2nd 4 chars).  vmnet has no kernel ifname we own,
	   so use the configured device name or a synthetic one. */
	p->name0 = p->name1 = 0;
	if (interface->device[0])
		memcpy ((char*) &p->name0, interface->device, 2 * sizeof (EmbWord));
	else
	  {
		char synthetic[8];
		snprintf (synthetic, sizeof (synthetic), "vmnet%d", unitNumber);
		memcpy ((char*) &p->name0, synthetic, 2 * sizeof (EmbWord));
	  }

	/* Determine the guest's Ethernet (MAC) address.  vmnet OWNS this: on tx
	   it validates the frame's source MAC, so the guest must originate with
	   exactly the MAC vmnet expects.  Default to the configured MAC (or a
	   locally-administered one); StartVMNetInterface overwrites it with the
	   address vmnet actually allocated. */
	if (interface->haveMac)
		memcpy (mac, interface->myMac.bytes, 6);
	else
	  {
		mac[0] = 0x02; mac[1] = 0x42; mac[2] = 0x23;
		mac[3] = 0x42; mac[4] = 0x00; mac[5] = (unsigned char) unitNumber;
	  }

#ifdef USE_VMNET
	StartVMNetInterface (p, interface, mac);	/* May replace mac[] with vmnet's */
#else
	p->vmnetInterface = NULL;
	p->vmnetQueue = NULL;
	p->vmnetSem = NULL;
	p->maxPacketSize = MaxEmbNetPacketSize;
#endif

	/* Publish the guest hardware address as raw bytes (high = bytes 0..3,
	   low = bytes 4..5).  No byte swap on little-endian arm64. */
	p->hardwareAddressHigh = p->hardwareAddressLow = 0;
	memcpy ((char*) &p->hardwareAddressHigh, mac, 6);
	printf ("net #%d MAC %02x:%02x:%02x:%02x:%02x:%02x\n", unitNumber,
			mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

	/* Host and guest network-layer addresses.  Config addresses are in host
	   byte order (see InterpretNetworkOptions); arm64 is little-endian, so we
	   follow the x86_64 convention and store them as-is. */
	p->hostPrimaryProtocol = ETHERTYPE_IP;
	p->hostPrimaryAddress = interface->myHostAddress.s_addr;
	p->guestPrimaryProtocol = interface->myProtocol;
	p->guestPrimaryAddress = interface->myAddress.s_addr;

	p->status = 0;
	p->net_broken = 0;
	p->nTransmitFailures = p->nReceiveFailures = 0;
	p->nFalseReceiverWakeups = p->nReceivedPacketsLost = 0;

	/* Create the four packet queues and wire the transmitter signal */

	p->guestToHostQueue = CreateQueue (NetworkTransmitterQueueSize, sizeof (EmbPtr));
	p->guestToHostQ = (EmbQueue*) HostPointer (p->guestToHostQueue);
	p->guestToHostQ->signal = InstallSignalHandler ((ProcPtrV) &NetworkChannelTransmitter,
													(PtrV) p, FALSE);

	p->guestToHostReturnQueue = CreateQueue (NetworkTransmitterQueueSize, sizeof (EmbPtr));
	p->guestToHostReturnQ = (EmbQueue*) HostPointer (p->guestToHostReturnQueue);

	p->hostToGuestSupplyQueue = CreateQueue (NetworkReceiverQueueSize, sizeof (EmbPtr));
	p->hostToGuestSupplyQ = (EmbQueue*) HostPointer (p->hostToGuestSupplyQueue);

	p->hostToGuestQueue = CreateQueue (NetworkReceiverQueueSize, sizeof (EmbPtr));
	p->hostToGuestQ = (EmbQueue*) HostPointer (p->hostToGuestQueue);

	/* Build the address string Genera parses (e.g. "INTERNET|10.0.0.2;mask=...") */

	for (pInterface = interface, firstInterface = TRUE; pInterface != NULL;
		 pInterface = pInterface->anotherAddress, firstInterface = FALSE)
	  {
		if (firstInterface)
			addressAsString[0] = 0;
		else
			sprintf (addressAsString, "%s,", addressAsString);
		if (pInterface->device[0])
			sprintf (addressAsString, "%s%s:", addressAsString, pInterface->device);
		switch (pInterface->myProtocol)
		  {
		  case ETHERTYPE_IP:
			{
			  struct in_addr guestAddress;
			  guestAddress.s_addr = htonl (pInterface->myAddress.s_addr);
			  sprintf (addressAsString, "%sINTERNET|%s", addressAsString,
					   inet_ntoa (guestAddress));
			}
			break;
		  case ETHERTYPE_CHAOS:
			sprintf (addressAsString, "%sCHAOS|%o", addressAsString,
					 htonl (pInterface->myAddress.s_addr));
			break;
		  }
		if (pInterface->myOptions[0])
			sprintf (addressAsString, "%s;%s", addressAsString, pInterface->myOptions);
	  }
	p->addressString = MakeEmbString (addressAsString);
	printf ("net #%d address %s\n", unitNumber, addressAsString);

	/* Start the receiver thread */

	if (pthread_create (&p->receiverThread, &EmbCommAreaPtr->inputThreadAttrs,
						(pthread_startroutine_t) &NetworkChannelReceiver, (pthread_addr_t) p))
		vpunt (NULL,
			   "Unable to create thread to receive packets for VLM network interface #%d",
			   unitNumber);
	p->receiverThreadSetup = TRUE;

	p->status |= EmbNetStatusHostReady;
}


/* Reset a network channel */

void ResetNetworkChannel (EmbChannel* channel)
{
  register EmbNetChannel* netChannel = (EmbNetChannel*) channel;

	ResetIncomingQueue (netChannel->guestToHostQ);
	ResetOutgoingQueue (netChannel->guestToHostReturnQ);

	ResetIncomingQueue (netChannel->hostToGuestSupplyQ);
	ResetOutgoingQueue (netChannel->hostToGuestQ);
}


/* Network channel transmitter -- invoked (as a signal handler) when the guest
   has queued one or more frames to send. */

void NetworkChannelTransmitter (EmbNetChannel* pNetChannel)
{
  register EmbNetChannel* netChannel = pNetChannel;
  register EmbQueue* transmitQueue = netChannel->guestToHostQ;
  register EmbQueue* returnQueue = netChannel->guestToHostReturnQ;
  EmbPtr netPacketPtr;
  EmbNetPacket* netPacket;
  ssize_t nBytes;
  Integer vma;

	while (EmbQueueFilled (transmitQueue))
	  {
		if (0 == EmbQueueSpace (returnQueue))
		  {
			/* Can't return the buffer now -- try again later */
			SignalLater (transmitQueue->signal);
			return;
		  }

		netPacketPtr = EmbQueueTakeWord (transmitQueue);
		if (NULL == (void*) (uint64_t) netPacketPtr) netPacketPtr = NullEmbPtr;

		if (netPacketPtr != NullEmbPtr)
		  {
			netPacket = (EmbNetPacket*) HostPointer (netPacketPtr);

			/* This host thread reads the packet buffer directly; if the GC
			   barrier is protecting its pages the fault would be delivered to
			   a non-emulator thread, which the wiring contract forbids (cf.
			   disks.c/console.c).  Open the header word first -- we need it
			   to learn the data length -- then the data words. */
			vma = (Integer)((EmbWord*) netPacket
							- (EmbWord*) MapVirtualAddressData (0));
			EnsureVirtualMemoryAccessible (vma, 1);
			nBytes = (ssize_t) netPacket->nBytes;
			if (nBytes > 0)
				EnsureVirtualMemoryAccessible (vma + 1, (int)((nBytes + 3) >> 2));

#ifdef USE_VMNET
			if (netChannel->vmnetInterface != NULL && nBytes > 0)
			  {
				struct vmpktdesc packet;
				struct iovec iov;
				int count = 1;
				unsigned char* frame = (unsigned char*) &netPacket->data[0];
				unsigned char padded[ETH_ZLEN];

				/* vmnet validates the source MAC: every transmitted frame must
				   originate with the address vmnet allocated to us.  The guest
				   normally fills it in correctly, but if it doesn't (Ethernet
				   source = bytes 6..11), rewrite it so vmnet won't drop the
				   frame -- the same fixup the Linux tap backend performs. */
				if (memcmp (frame + ETH_ALEN,
							(unsigned char*) &netChannel->hardwareAddressHigh,
							ETH_ALEN) != 0)
				  {
					if (!netChannel->net_broken)
					  {
						vwarn ("net tx",
							   "ch%d: frame source MAC != interface MAC; rewriting it",
							   netChannel->unit);
						netChannel->net_broken = 1;
					  }
					memcpy (frame + ETH_ALEN,
							(unsigned char*) &netChannel->hardwareAddressHigh,
							ETH_ALEN);
				  }

				/* Ethernet requires at least ETH_ZLEN octets on the wire; pad
				   short frames with zeros through a scratch buffer. */
				if (nBytes < ETH_ZLEN)
				  {
					memset (padded, 0, sizeof (padded));
					memcpy (padded, frame, (size_t) nBytes);
					iov.iov_base = padded;
					nBytes = ETH_ZLEN;
				  }
				else
					iov.iov_base = frame;

				iov.iov_len = (size_t) nBytes;
				packet.vm_pkt_size = (size_t) nBytes;
				packet.vm_pkt_iov = &iov;
				packet.vm_pkt_iovcnt = 1;
				packet.vm_flags = 0;

				if (vmnet_write ((interface_ref) netChannel->vmnetInterface,
								 &packet, &count) != VMNET_SUCCESS || count < 1)
					netChannel->nTransmitFailures++;
			  }
#else
			(void) nBytes;					/* Sink: drop the frame */
#endif

			EmbQueuePutWord (returnQueue, netPacketPtr);
		  }
	  }
}


/* Network channel receiver thread */

#define OneMillisecond 1000000L

void NetworkChannelReceiver (pthread_addr_t argument)
{
  register EmbNetChannel* netChannel = (EmbNetChannel*) argument;

	/* The thread is left joinable: TerminateNetChannelDarwin does
	   pthread_cancel + pthread_join.  Do NOT self-detach (the Linux backend
	   does, but on macOS joining a detached thread makes pthread_join hang
	   forever, which wedged shutdown). */

	WaitUntilInitializationComplete ();

#ifdef USE_VMNET
  {
	register EmbQueue* supplyQueue = netChannel->hostToGuestSupplyQ;
	register EmbQueue* receiveQueue = netChannel->hostToGuestQ;
	interface_ref iface = (interface_ref) netChannel->vmnetInterface;
	dispatch_semaphore_t pktSem = (dispatch_semaphore_t) netChannel->vmnetSem;

	while (!netChannel->receiverStop)
	  {
		/* Wait (with a short timeout, so shutdown stays responsive) for the
		   vmnet event callback to announce that packets are available. */
		if (dispatch_semaphore_wait (pktSem,
				dispatch_time (DISPATCH_TIME_NOW, NSEC_PER_SEC / 4)) != 0)
			continue;

		/* Drain all currently-available frames */
		for (;;)
		  {
			struct vmpktdesc packet;
			struct iovec iov;
			int count = 1;
			EmbPtr netPacketPtr;
			EmbNetPacket* netPacket;

			iov.iov_base = &netChannel->receiveBuffer[0];
			iov.iov_len = MaxEmbNetPacketSize;
			packet.vm_pkt_size = MaxEmbNetPacketSize;
			packet.vm_pkt_iov = &iov;
			packet.vm_pkt_iovcnt = 1;
			packet.vm_flags = 0;

			if (vmnet_read (iface, &packet, &count) != VMNET_SUCCESS)
			  {
				netChannel->nReceiveFailures++;
				break;
			  }
			if (count < 1)
				break;					/* No more frames right now */

			if ((0 == EmbQueueSpace (supplyQueue)) || (0 == EmbQueueSpace (receiveQueue)))
			  {
				netChannel->nReceivedPacketsLost++;
				continue;
			  }

			/* The guest may not supply a buffer for a long time (e.g., its
			   network driver isn't up yet).  Keep polling receiverStop while
			   we wait, or shutdown's pthread_join would hang here. */
			while (0 == (netPacketPtr = EmbQueueTakeWord (supplyQueue)))
			  {
				struct timespec pause;
				if (netChannel->receiverStop)
					break;
				pause.tv_sec = 0;
				pause.tv_nsec = OneMillisecond;
				nanosleep (&pause, NULL);
			  }
			if (0 == netPacketPtr)
				break;					/* Shutting down -- drop the frame */
			netPacket = (EmbNetPacket*) HostPointer (netPacketPtr);
			/* As in the transmitter: open the buffer's pages before this
			   host thread writes the header and data into them. */
			EnsureVirtualMemoryAccessible (
				(Integer)((EmbWord*) netPacket - (EmbWord*) MapVirtualAddressData (0)),
				1 + (int)((packet.vm_pkt_size + 3) >> 2));
			netPacket->nBytes = (EmbWord) packet.vm_pkt_size;
			memcpy (&netPacket->data[0], &netChannel->receiveBuffer[0],
					packet.vm_pkt_size);
			EmbQueuePutWord (receiveQueue, netPacketPtr);
		  }
	  }
  }
#else
	/* Sink: no host-side frames are delivered.  Idle until shutdown sets the
	   stop flag (polled with a short sleep so teardown returns promptly). */
	while (!netChannel->receiverStop)
	  {
		struct timespec pause;
		pause.tv_sec = 0;
		pause.tv_nsec = 100000000L;			/* 100 ms */
		nanosleep (&pause, NULL);
	  }
#endif
}


#ifdef USE_VMNET

/* Extract the value of a "key=value" item from the interface's option string
   (the part of the -network spec after the first semicolon, e.g.
   "mask=255.255.255.0;gateway=192.168.2.1"). */

static boolean ExtractNetOption (const char* options, const char* key,
								 char* out, size_t outSize)
{
  const char* start = strcasestr (options, key);
  size_t len;

	if (NULL == start)
		return (FALSE);
	start += strlen (key);
	len = strcspn (start, ";");
	if (0 == len || len >= outSize)
		return (FALSE);
	memcpy (out, start, len);
	out[len] = 0;
	return (TRUE);
}


/* Start a vmnet shared-mode interface for this channel.  Blocks until the
   asynchronous start completes, captures the vmnet-allocated MAC into mac[6],
   and registers the packet-available event callback. */

static void StartVMNetInterface (EmbNetChannel* p, NetworkInterface* interface,
								 unsigned char mac[6])
{
  xpc_object_t interfaceDesc = xpc_dictionary_create (NULL, NULL, 0);
  dispatch_queue_t queue =
	  dispatch_queue_create ("com.symbolics.vlm.vmnet", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t startSem = dispatch_semaphore_create (0);
  dispatch_semaphore_t pktSem = dispatch_semaphore_create (0);
  uuid_t interfaceID;
  interface_ref iface;
  __block vmnet_return_t startStatus = VMNET_FAILURE;
  __block uint64_t maxPacket = MaxEmbNetPacketSize;
  char macString[64] = "";
  char* macp = macString;		/* Capture a pointer: blocks can't __block a C array */
  char startAddr[32] = "", endAddr[32] = "", subnetMask[32] = "";
  char* startp = startAddr;
  char* endp = endAddr;
  char* maskp = subnetMask;

	uuid_generate_random (interfaceID);
	xpc_dictionary_set_uuid (interfaceDesc, vmnet_interface_id_key, interfaceID);
	xpc_dictionary_set_uint64 (interfaceDesc, vmnet_operation_mode_key, VMNET_SHARED_MODE);
	xpc_dictionary_set_bool (interfaceDesc, vmnet_allocate_mac_address_key, true);
	xpc_dictionary_set_uint64 (interfaceDesc, vmnet_max_packet_size_key, MaxEmbNetPacketSize);

	/* Pin the NAT subnet to the guest's configured network instead of letting
	   vmnet pick one, so host/gateway addresses baked into the world's
	   namespace (and services that key off them, e.g. NFS) keep working.  The
	   gateway (= subnet start address, where vmnet puts the host) and mask
	   come from the -network option string; the DHCP range end is the last
	   usable address.  vmnet only accepts RFC 1918 ranges -- if it rejects
	   the request, vmnet_start_interface fails and we punt with its status. */
	if (interface->myProtocol == ETHERTYPE_IP && interface->myAddress.s_addr != 0)
	  {
		char reqMask[32], reqStart[32], reqEnd[32];
		uint32_t addr = interface->myAddress.s_addr;	/* Host byte order */
		uint32_t mask;
		struct in_addr a;

		if (!ExtractNetOption (interface->myOptions, "mask=", reqMask, sizeof (reqMask)))
			strcpy (reqMask, "255.255.255.0");
		mask = ntohl (inet_addr (reqMask));
		if (!ExtractNetOption (interface->myOptions, "gateway=", reqStart, sizeof (reqStart)))
		  {
			a.s_addr = htonl ((addr & mask) | 1);
			strcpy (reqStart, inet_ntoa (a));
		  }
		a.s_addr = htonl ((addr | ~mask) - 1);
		strcpy (reqEnd, inet_ntoa (a));

		xpc_dictionary_set_string (interfaceDesc, vmnet_start_address_key, reqStart);
		xpc_dictionary_set_string (interfaceDesc, vmnet_end_address_key, reqEnd);
		xpc_dictionary_set_string (interfaceDesc, vmnet_subnet_mask_key, reqMask);
	  }

	iface = vmnet_start_interface (interfaceDesc, queue,
		^(vmnet_return_t status, xpc_object_t interfaceParam)
		{
			startStatus = status;
			if (status == VMNET_SUCCESS && interfaceParam != NULL)
			  {
				const char* m =
					xpc_dictionary_get_string (interfaceParam, vmnet_mac_address_key);
				if (m != NULL)
					strlcpy (macp, m, 64);
				if (xpc_dictionary_get_value (interfaceParam, vmnet_max_packet_size_key))
					maxPacket =
						xpc_dictionary_get_uint64 (interfaceParam, vmnet_max_packet_size_key);
				/* SHARED_MODE picks its own NAT subnet; capture it so we can
				   report what Genera's static address must align with. */
				{
				  const char* s =
					  xpc_dictionary_get_string (interfaceParam, vmnet_start_address_key);
				  const char* e =
					  xpc_dictionary_get_string (interfaceParam, vmnet_end_address_key);
				  const char* k =
					  xpc_dictionary_get_string (interfaceParam, vmnet_subnet_mask_key);
				  if (s != NULL) strlcpy (startp, s, 32);
				  if (e != NULL) strlcpy (endp, e, 32);
				  if (k != NULL) strlcpy (maskp, k, 32);
				}
			  }
			dispatch_semaphore_signal (startSem);
		});

	/* A NULL return means vmnet_start_interface failed synchronously and the
	   completion block will NEVER run -- check before waiting on startSem, or
	   we'd block forever instead of reporting the failure. */
	if (iface == NULL)
	  {
		xpc_release (interfaceDesc);
		vpunt (NULL,
			   "vmnet_start_interface failed for VLM network interface #%d"
			   " -- shared mode requires running genera as root (sudo)",
			   (int) p->unit);
	  }

	dispatch_semaphore_wait (startSem, DISPATCH_TIME_FOREVER);
	xpc_release (interfaceDesc);

	if (startStatus != VMNET_SUCCESS)
		vpunt (NULL,
			   "vmnet_start_interface failed (status %d) for VLM network interface #%d"
			   " -- shared mode requires running genera as root (sudo)",
			   (int) startStatus, (int) p->unit);

	/* Adopt the MAC vmnet allocated -- frames must originate with it. */
	if (macString[0])
	  {
		unsigned int b[6];
		if (6 == sscanf (macString, "%x:%x:%x:%x:%x:%x",
						 &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]))
		  {
			int i;
			for (i = 0; i < 6; i++) mac[i] = (unsigned char) b[i];
		  }
	  }

	/* Report the NAT subnet vmnet assigned.  In SHARED_MODE vmnet runs a DHCP
	   server on this range with the gateway at the start address; Genera does
	   not DHCP, so its statically-configured INTERNET address (and gateway)
	   must lie within this subnet for IP traffic to route to the host. */
	if (startAddr[0])
		printf ("net #%d vmnet subnet %s - %s mask %s (gateway = %s);"
				" align Genera's static address with this range\n",
				(int) p->unit, startAddr, endAddr, subnetMask, startAddr);

	/* Bridge vmnet's async event callback to the receiver thread. */
	vmnet_interface_set_event_callback (iface, VMNET_INTERFACE_PACKETS_AVAILABLE, queue,
		^(interface_event_t event_mask, xpc_object_t event)
		{
			(void) event_mask; (void) event;
			dispatch_semaphore_signal (pktSem);
		});

	p->vmnetInterface = (void*) iface;
	p->vmnetQueue = (void*) queue;
	p->vmnetSem = (void*) pktSem;
	p->maxPacketSize = (EmbWord) maxPacket;
}

#endif /* USE_VMNET */


/* Cleanup a single network channel */

static void TerminateNetChannelDarwin (EmbNetChannel* netChannel)
{
  void* exitValue;

	if (netChannel->receiverThreadSetup)
	  {
		/* Ask the receiver to exit, then join.  We deliberately do NOT use
		   pthread_cancel: macOS delivers it unreliably, and the resulting
		   join could block forever (that wedged Ctrl-X shutdown).  The
		   thread polls receiverStop and exits within its sleep interval. */
		netChannel->receiverStop = 1;
		pthread_join (netChannel->receiverThread, &exitValue);
		netChannel->receiverThreadSetup = FALSE;
	  }

#ifdef USE_VMNET
	if (netChannel->vmnetInterface != NULL)
	  {
		dispatch_semaphore_t stopSem = dispatch_semaphore_create (0);
		vmnet_stop_interface ((interface_ref) netChannel->vmnetInterface,
			(dispatch_queue_t) netChannel->vmnetQueue,
			^(vmnet_return_t status) { (void) status; dispatch_semaphore_signal (stopSem); });
		dispatch_semaphore_wait (stopSem, DISPATCH_TIME_FOREVER);
		netChannel->vmnetInterface = NULL;
	  }
#endif
}


/* Cleanup the network channels */

void TerminateNetworkChannels ()
{
  EmbNetChannel* netChannel;
  EmbPtr channel;

	for (channel = EmbCommAreaPtr->channel_table; channel != NullEmbPtr;
		 channel = netChannel->next)
	  {
		netChannel = (EmbNetChannel*) HostPointer (channel);
		if (EmbNetworkChannelType == netChannel->type)
			TerminateNetChannelDarwin (netChannel);
	  }
}
