/**
 * Transport boundary for the WhatsApp channel.
 *
 * Everything above this line (access control, pairing, dedupe, permission
 * relay, chunking, the MCP wiring) is transport-independent and lives in
 * server.ts. Everything below it is the specifics of one way of reaching
 * WhatsApp: the official Cloud API, or a linked device.
 */

/** A message arriving from WhatsApp, normalized across transports. */
export type InboundMessage = {
  /** Sender's wa_id: digits only, international format, no '+'. */
  senderId: string
  messageId: string
  /** Epoch milliseconds. */
  timestamp: number
  /** Display text, or a parenthesized placeholder like '(voice note)'. */
  text: string
  profileName?: string
  /** 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | ... */
  msgType: string
  /**
   * Opaque handle the transport can later resolve to bytes — a Cloud API media
   * id, or a linked-device message id. Pass it back to downloadMedia.
   */
  mediaRef?: string
  mime?: string
  fileName?: string
  /** Set when the transport already fetched the media (small images). */
  mediaPath?: string
  /** Set when this message is a tap on an interactive button. */
  buttonId?: string
}

export type TransportCapabilities = {
  /**
   * True when WhatsApp's 24-hour customer service window applies, i.e. the
   * business-platform rule that free-form sends need a recent inbound message.
   * A linked device is just a client, so it has no such window.
   */
  serviceWindow: boolean
  /** Pre-approved message templates — business platform only. */
  templates: boolean
  /** Interactive reply buttons. Not available to a linked device. */
  buttons: boolean
}

export type TransportHandlers = {
  onMessage: (m: InboundMessage) => Promise<void>
  /** Human-readable lifecycle notes for stderr and /whatsapp:link. */
  onStatus: (line: string) => void
}

export interface Transport {
  readonly name: string
  readonly capabilities: TransportCapabilities

  /** Begin receiving. Resolves once the transport is up (not necessarily linked). */
  start(handlers: TransportHandlers): Promise<void>

  sendText(to: string, text: string, previewUrl?: boolean): Promise<string>
  sendFile(to: string, path: string, caption?: string): Promise<string>

  /** Only when capabilities.buttons. */
  sendButtons?(to: string, body: string, buttons: { id: string; title: string }[]): Promise<string>
  /** Only when capabilities.templates. */
  sendTemplate?(to: string, name: string, languageCode: string, bodyParams: string[]): Promise<string>

  /** Resolve a mediaRef to a local file path. */
  downloadMedia(mediaRef: string): Promise<string>

  /** Best-effort read receipt / typing hint. Never throws. */
  markRead?(messageId: string, senderId: string): Promise<void>

  /**
   * True when this sender is the account the transport itself runs as. On a
   * linked device the user's own self-chat is the normal way to reach the
   * assistant, so it skips pairing — the same concession the official
   * iMessage channel makes for texting yourself.
   */
  isSelf?(senderId: string): boolean

  stop(): void | Promise<void>
}

/** Strip everything but digits — both transports key on a bare wa_id. */
export function normalizeWaId(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

/**
 * Sender-controlled strings (profile names, filenames, captions) land inside
 * the <channel> tag. Delimiters would let a sender close the tag early or
 * forge an extra meta attribute.
 */
export function safeMeta(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_').slice(0, 300)
}
