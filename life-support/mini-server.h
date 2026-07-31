/* -*- Mode: C; Tab-Width: 4 -*- */

/* Embedded Chaosnet MINI cold-load file server.
 *
 * Impersonates a chaos host (default #o401) on the guest's wire so a cold
 * load can MINI-load the inner Genera system (SI:QLD) without any external
 * file server.  The client is SYS:IO;LMINI; see mini-server.c for the
 * protocol contract.  All entry points are no-ops until MiniServerStart
 * has been called with a serving root.
 */

#ifndef __mini_server_h__
#define __mini_server_h__

/* Start the server on a channel.  serverAddr/guestAddr are chaos addresses
   in host order (e.g. 0401, 0402); root is the SYS: translation root
   (the rel-8-5 "sys" directory).  Returns TRUE if the server thread was
   created. */
boolean MiniServerStart (EmbNetChannel* channel, unsigned short serverAddr,
						 unsigned short guestAddr, const char* root);

/* Stop the server thread and release its resources.  Safe when not started. */
void MiniServerStop (void);

/* Called by the network transmitter for every outbound guest frame.  Returns
   TRUE when the frame was addressed to the MINI server and has been consumed
   (the caller returns the buffer to the guest and must NOT transmit it). */
boolean MiniServerInterceptFrame (EmbNetChannel* channel,
								  const unsigned char* frame, size_t nBytes);

/* Called by the network receiver thread after each wakeup.  Copies one
   pending server->guest frame into buf and returns TRUE, or returns FALSE
   when none are pending. */
boolean MiniServerTakeInjectedFrame (EmbNetChannel* channel,
									 unsigned char* buf, size_t bufSize,
									 size_t* nBytes);

#endif /* __mini_server_h__ */
