/* -*- Mode: C; Tab-Width: 4 -*- */

#include <string.h>
#include <uuid/uuid.h>
#include <CommonCrypto/CommonDigest.h>

#include "netid.h"

/* RFC 9562 version 5 UUID, as the VLM computes it */
void vlm_network_identifier (uint32_t subnetHostOrder, char out[37])
{
  uuid_t namespace, result;
  unsigned char name[4];
  unsigned char hash[CC_SHA1_DIGEST_LENGTH];
  CC_SHA1_CTX ctx;

	uuid_parse (VLM_NETWORK_NAMESPACE, namespace);
	name[0] = (unsigned char) (subnetHostOrder >> 24);
	name[1] = (unsigned char) (subnetHostOrder >> 16);
	name[2] = (unsigned char) (subnetHostOrder >> 8);
	name[3] = (unsigned char) subnetHostOrder;
	CC_SHA1_Init (&ctx);
	CC_SHA1_Update (&ctx, namespace, sizeof (uuid_t));
	CC_SHA1_Update (&ctx, name, sizeof (name));
	CC_SHA1_Final (hash, &ctx);
	memcpy (result, hash, sizeof (uuid_t));
	result[6] = (unsigned char) ((result[6] & 0x0F) | 0x50);	/* Version 5 */
	result[8] = (unsigned char) ((result[8] & 0x3F) | 0x80);	/* RFC 4122 variant */
	uuid_unparse_upper (result, out);
}
