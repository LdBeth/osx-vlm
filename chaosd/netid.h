/* -*- Mode: C; Tab-Width: 4 -*- */

/* The vmnet network identifier the official Portable Genera VLM uses for a
 * host-only ("private") or shared network (VLM-12.10.3,
 * life-support/network-darwin.c): a UUIDv5 (SHA-1) in namespace
 * EBF87D3A-7D21-4D37-A92F-36E49E9F640D over the 4-byte network-order /24
 * subnet address.  An interface started with the same identifier and the
 * same start/end/mask lands on the VLM's L2 segment. */

#ifndef CHAOSD_NETID_H
#define CHAOSD_NETID_H

#include <stdint.h>

#define VLM_NETWORK_NAMESPACE "EBF87D3A-7D21-4D37-A92F-36E49E9F640D"

/* subnetHostOrder is e.g. 0xC0A80200 for 192.168.2.0; out gets the
   upper-case UUID string (37 bytes including NUL) */
void vlm_network_identifier (uint32_t subnetHostOrder, char out[37]);

#endif
