/* -*- Mode: C; Tab-Width: 4 -*- */

/* chaosd's vmnet station: its own vmnet interface (own MAC) on the VLM's
 * host-only L2 network. */

#ifndef CHAOSD_VMNET_TRANSPORT_H
#define CHAOSD_VMNET_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

typedef struct VmnetTransport VmnetTransport;

/* Start in VMNET_HOST_MODE on subnetHostOrder/24 (e.g. 0xC0A80200), with the
   VLM's start/end/mask and network identifier; shared selects
   VMNET_SHARED_MODE (the VLM's mode=shared).  Returns NULL and fills err on
   failure.  Needs root. */
VmnetTransport* vmnet_transport_start (uint32_t subnetHostOrder, int shared,
									   char* err, size_t errSize);
const unsigned char* vmnet_transport_mac (VmnetTransport* t);
const char* vmnet_transport_network_id (VmnetTransport* t);
/* Readable when frames may be waiting */
int vmnet_transport_notify_fd (VmnetTransport* t);
void vmnet_transport_clear_notify (VmnetTransport* t);
/* One frame, 0 if none */
size_t vmnet_transport_read (VmnetTransport* t, unsigned char* buf, size_t max);
int vmnet_transport_write (VmnetTransport* t, const unsigned char* frame, size_t nBytes);
void vmnet_transport_stop (VmnetTransport* t);

#endif
