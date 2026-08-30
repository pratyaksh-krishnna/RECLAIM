import { env } from '../config/env.js';
import { MetaWhatsAppSender, MockWhatsAppSender } from './whatsapp.js';
import type { WhatsAppSender } from './whatsapp.js';

/**
 * Delivery. The default is mock, so a voice note is generated and shown in the
 * console and reaches nobody until this one word changes.
 */
export function getWhatsAppSender(): WhatsAppSender {
  return env.WHATSAPP_MODE === 'live'
    ? new MetaWhatsAppSender(env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID)
    : new MockWhatsAppSender();
}

export { MetaWhatsAppSender, MockWhatsAppSender } from './whatsapp.js';
export type { SendVoiceArgs, SendVoiceResult, WhatsAppSender } from './whatsapp.js';
export { WHATSAPP_WINDOW_HOURS, isWhatsAppWindowOpen } from './window.js';
