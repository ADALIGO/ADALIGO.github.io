// SPDX-License-Identifier: MIT

import { createHmac } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GridFSBucket,
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
} from 'mongodb';
import type { IncomingMessage, ServerResponse } from 'node:http';

type PlaybackState = {
  volumePercent: number;
  muted: boolean;
  playing: boolean;
};

type SyncCommand = {
  type: 'play' | 'pause' | 'mute' | 'unmute' | 'volume';
  value?: number;
};

type SharedTrack = {
  id: string;
  title: string;
  artist: string;
  kind: 'file' | 'url';
  audioUrl?: string;
  fileFingerprint?: string;
  contentType?: string;
  fileId?: ObjectId;
};

type Room = {
  clients: Map<string, ServerResponse>;
  state: PlaybackState;
  ownerClientId: string | null;
  leaseExpiresAt: number;
};

type TrackDocument = SharedTrack & {
  _id: string;
  roomHash: string;
  updatedAt: Date;
};

const ROOM_CODE_PATTERN = /^[a-f0-9]{48}$/i;
const DEVICE_CODE_PATTERN = /^[a-f0-9]{24}$/i;
const CLIENT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const TRACK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const LEASE_MS = 10_000;

const rooms = new Map<string, Room>();
const mongoUri = process.env.DATABASE_URL?.trim();
const syncSecret = process.env.MUSIC_SYNC_SECRET?.trim();
let mongoClient: MongoClient | undefined;
let mongoDb: Db | undefined;
let tracksCollection: Collection<TrackDocument> | undefined;
let audioBucket: GridFSBucket | undefined;
let mongoReady: Promise<{ db: Db; bucket: GridFSBucket; tracks: Collection<TrackDocument> }> | undefined;

class RelayRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function getRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      clients: new Map(),
      state: { volumePercent: 100, muted: false, playing: false },
      ownerClientId: null,
      leaseExpiresAt: 0,
    };
    rooms.set(roomId, room);
  }
  return room;
}

function sendEvent(response: ServerResponse, event: string, value: unknown): void {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
}

function broadcast(room: Room, event: string, value: unknown): void {
  for (const response of room.clients.values()) sendEvent(response, event, value);
}

function releaseExpiredLease(room: Room): void {
  if (room.ownerClientId && room.leaseExpiresAt <= Date.now()) {
    room.ownerClientId = null;
    room.leaseExpiresAt = 0;
    room.state.playing = false;
    broadcast(room, 'owner', { clientId: null });
    broadcast(room, 'state', room.state);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BYTES) throw new RelayRequestError('Request body is too large.', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RelayRequestError('Request body must be valid JSON.', 400);
  }
}

function getPairingFromValues(
  roomId: string,
  deviceId: string,
  clientId: string,
  response: ServerResponse,
) {
  if (!ROOM_CODE_PATTERN.test(roomId) || !DEVICE_CODE_PATTERN.test(deviceId) ||
    (clientId && !CLIENT_ID_PATTERN.test(clientId))) {
    sendJson(response, 400, { error: 'A valid music pairing code is required.' });
    return null;
  }
  return { roomId: roomId.toLowerCase(), deviceId: deviceId.toLowerCase(), clientId: clientId.toLowerCase() };
}

function getPairing(url: URL, response: ServerResponse) {
  return getPairingFromValues(
    url.searchParams.get('roomId') ?? '',
    url.searchParams.get('deviceId') ?? '',
    url.searchParams.get('clientId') ?? '',
    response,
  );
}

async function getMongoCollections() {
  if (!mongoUri || !syncSecret) {
    throw new Error('Music library sync requires DATABASE_URL and MUSIC_SYNC_SECRET.');
  }
  if (!mongoReady) {
    mongoReady = (async () => {
      mongoClient = new MongoClient(mongoUri);
      await mongoClient.connect();
      mongoDb = mongoClient.db();
      audioBucket = new GridFSBucket(mongoDb, { bucketName: 'music_sync_audio' });
      tracksCollection = mongoDb.collection<TrackDocument>('music_sync_tracks');
      await tracksCollection.createIndex({ roomHash: 1, id: 1 }, { unique: true });
      return { db: mongoDb, bucket: audioBucket, tracks: tracksCollection };
    })();
  }
  return mongoReady;
}

function hashRoomId(roomId: string): string {
  if (!syncSecret) throw new Error('Music library sync requires MUSIC_SYNC_SECRET.');
  return createHmac('sha256', syncSecret).update(roomId).digest('hex');
}

function validTrack(value: unknown): value is Omit<SharedTrack, 'fileId' | 'contentType'> {
  if (typeof value !== 'object' || value === null || !('id' in value) ||
    typeof value.id !== 'string' || !TRACK_ID_PATTERN.test(value.id) ||
    !('title' in value) || typeof value.title !== 'string' || value.title.length > 300 ||
    !('artist' in value) || typeof value.artist !== 'string' || value.artist.length > 300 ||
    !('kind' in value) || (value.kind !== 'file' && value.kind !== 'url')) return false;
  if (value.kind === 'url') {
    if (!('audioUrl' in value) || typeof value.audioUrl !== 'string' || value.audioUrl.length > 2048) return false;
    try {
      const parsed = new URL(value.audioUrl);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }
  return !('fileFingerprint' in value) ||
    (typeof value.fileFingerprint === 'string' && value.fileFingerprint.length <= 512);
}

function publicTrack(track: TrackDocument, roomId: string, deviceId: string): SharedTrack & { audioUrl?: string } {
  const result: SharedTrack & { audioUrl?: string } = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    kind: track.kind,
    ...(track.audioUrl ? { audioUrl: track.audioUrl } : {}),
  };
  if (track.kind === 'file' && track.fileId) {
    const audioUrl = new URL(`/v1/library/audio/${encodeURIComponent(track.id)}`, 'https://music-sync.invalid');
    audioUrl.searchParams.set('roomId', roomId);
    audioUrl.searchParams.set('deviceId', deviceId);
    result.audioUrl = audioUrl.pathname + audioUrl.search;
  }
  return result;
}

class SizeLimit extends Transform {
  private total = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.limit) {
      callback(new Error(`Audio uploads cannot exceed ${Math.floor(this.limit / 1024 / 1024)} MB.`));
      return;
    }
    callback(null, chunk);
  }
}

async function handleLibraryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  pathname: string,
): Promise<void> {
  const pairing = getPairing(url, response);
  if (!pairing) return;
  const { db, bucket, tracks } = await getMongoCollections();
  const roomHash = hashRoomId(pairing.roomId);

  if (pathname === '/v1/library' && request.method === 'GET') {
    const savedTracks = await tracks.find({ roomHash }).sort({ title: 1 }).toArray();
    sendJson(response, 200, {
      tracks: savedTracks.map((track) => publicTrack(track, pairing.roomId, pairing.deviceId)),
    });
    return;
  }

  if (pathname === '/v1/library' && request.method === 'PUT') {
    const body = await readJson(request);
    if (typeof body !== 'object' || body === null || !('tracks' in body) ||
      !Array.isArray(body.tracks) || body.tracks.length > 500 ||
      !body.tracks.every(validTrack)) {
      sendJson(response, 400, { error: 'The shared library must contain up to 500 valid tracks.' });
      return;
    }
    const missingFiles: string[] = [];
    for (const track of body.tracks) {
      const existing = await tracks.findOne({ roomHash, id: track.id });
      if (track.kind === 'file' &&
        (!existing?.fileId || existing.fileFingerprint !== track.fileFingerprint)) {
        missingFiles.push(track.id);
      }
      await tracks.updateOne(
        { roomHash, id: track.id },
        {
          $set: { ...track, roomHash, updatedAt: new Date() },
          ...(existing?.fileId ? { $setOnInsert: { fileId: existing.fileId } } : {}),
        },
        { upsert: true },
      );
    }
    broadcast(getRoom(pairing.roomId), 'library', {});
    sendJson(response, 200, { missingFiles });
    return;
  }

  const trackMatch = pathname.match(/^\/v1\/library\/(audio\/)?([a-zA-Z0-9_-]{1,128})(\/file)?$/);
  if (!trackMatch) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  const isAudio = Boolean(trackMatch[1]);
  const trackId = trackMatch[2];
  const isFileUpload = Boolean(trackMatch[3]);
  const track = await tracks.findOne({ roomHash, id: trackId });
  if (!track) {
    sendJson(response, 404, { error: 'The shared track was not found.' });
    return;
  }

  if (isFileUpload && request.method === 'PUT') {
    if (track.kind !== 'file') {
      sendJson(response, 400, { error: 'Only audio file tracks can be uploaded.' });
      return;
    }
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('audio/')) {
      sendJson(response, 415, { error: 'Upload an audio file with an audio/* content type.' });
      return;
    }
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (contentLength > MAX_AUDIO_BYTES) {
      sendJson(response, 413, { error: 'Audio uploads cannot exceed 100 MB.' });
      return;
    }
    const fileId = new ObjectId();
    const upload = bucket.openUploadStreamWithId(fileId, track.title, {
      contentType,
      metadata: { roomHash, trackId },
    });
    try {
      await pipeline(request, new SizeLimit(MAX_AUDIO_BYTES), upload);
      await tracks.updateOne({ roomHash, id: trackId }, { $set: { fileId, contentType } });
      if (track.fileId) {
        await bucket.delete(track.fileId).catch((error: unknown) => {
          console.error('Unable to remove the previous shared audio upload.', error);
        });
      }
      broadcast(getRoom(pairing.roomId), 'library', {});
      sendJson(response, 200, { saved: true });
    } catch (error) {
      await bucket.delete(fileId).catch((cleanupError: unknown) => {
        console.error('Unable to clean up an incomplete shared audio upload.', cleanupError);
      });
      throw error;
    }
    return;
  }

  if (isAudio && request.method === 'GET') {
    if (!track.fileId || track.kind !== 'file') {
      sendJson(response, 404, { error: 'The audio file is not available.' });
      return;
    }
    const file = await db.collection('music_sync_audio.files').findOne({ _id: track.fileId });
    if (!file || typeof file.length !== 'number') {
      sendJson(response, 404, { error: 'The audio file is not available.' });
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = file.length - 1;
    if (range) {
      if (!range[1]) {
        const suffixLength = Number(range[2]);
        if (suffixLength <= 0 || file.length === 0) {
          response.writeHead(416, { 'Content-Range': `bytes */${file.length}` });
          response.end();
          return;
        }
        start = Math.max(0, file.length - suffixLength);
      } else {
        start = Number(range[1]);
        if (range[2]) end = Number(range[2]);
      }
      if (start >= file.length || end < start || file.length === 0) {
        response.writeHead(416, { 'Content-Range': `bytes */${file.length}` });
        response.end();
        return;
      }
      end = Math.min(end, file.length - 1);
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': track.contentType ?? 'audio/mpeg',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}),
    });
    await pipeline(bucket.openDownloadStream(track.fileId, range ? { start, end: end + 1 } : {}), response);
    return;
  }

  if (!isAudio && !isFileUpload && request.method === 'DELETE') {
    if (track.fileId) await bucket.delete(track.fileId);
    await tracks.deleteOne({ roomHash, id: trackId });
    broadcast(getRoom(pairing.roomId), 'library', {});
    sendJson(response, 200, { deleted: true });
    return;
  }

  response.setHeader('Allow', isFileUpload ? 'PUT, OPTIONS' : isAudio ? 'GET, OPTIONS' : 'DELETE, OPTIONS');
  sendJson(response, 405, { error: 'Method not allowed.' });
}

export async function handleMusicSyncRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/v1/')) return false;

  if (pathname.startsWith('/v1/library')) {
    try {
      await handleLibraryRequest(request, response, url, pathname);
    } catch (error) {
      if (!response.headersSent) {
        const message = error instanceof Error ? error.message : 'The music library request failed.';
        const status = error instanceof RelayRequestError
          ? error.status
          : message.includes('cannot exceed') ? 413 : 503;
        sendJson(response, status, { error: message });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
    return true;
  }

  if (pathname === '/v1/events' && request.method === 'GET') {
    const pairing = getPairing(url, response);
    if (!pairing || !pairing.clientId) {
      if (!response.headersSent) sendJson(response, 400, { error: 'A valid client ID is required.' });
      return true;
    }
    const room = getRoom(pairing.roomId);
    releaseExpiredLease(room);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    room.clients.set(pairing.clientId, response);
    sendEvent(response, 'owner', { clientId: room.ownerClientId });
    sendEvent(response, 'state', room.state);
    const heartbeat = setInterval(() => {
      releaseExpiredLease(room);
      if (response.destroyed || response.writableEnded) {
        clearInterval(heartbeat);
        room.clients.delete(pairing.clientId);
        return;
      }
      response.write(': keep-alive\n\n');
    }, 15_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      if (room.clients.get(pairing.clientId) === response) room.clients.delete(pairing.clientId);
    });
    return true;
  }

  if (pathname === '/v1/lease' && request.method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!(error instanceof RelayRequestError)) throw error;
      sendJson(response, error.status, { error: error.message });
      return true;
    }
    const pairing = typeof body === 'object' && body !== null &&
      'roomId' in body && typeof body.roomId === 'string' &&
      'deviceId' in body && typeof body.deviceId === 'string' &&
      'clientId' in body && typeof body.clientId === 'string'
      ? getPairingFromValues(body.roomId, body.deviceId, body.clientId, response)
      : null;
    if (!pairing || typeof body !== 'object' || body === null || !('action' in body) ||
      !['acquire', 'heartbeat', 'release'].includes(String(body.action))) {
      if (!response.headersSent) sendJson(response, 400, { error: 'A valid lease action and pairing code are required.' });
      return true;
    }
    const room = getRoom(pairing.roomId);
    releaseExpiredLease(room);
    const action = body.action as 'acquire' | 'heartbeat' | 'release';
    let granted = false;
    if (action === 'acquire' && (!room.ownerClientId || room.ownerClientId === pairing.clientId)) {
      room.ownerClientId = pairing.clientId;
      room.leaseExpiresAt = Date.now() + LEASE_MS;
      granted = true;
    } else if (action === 'heartbeat' && room.ownerClientId === pairing.clientId) {
      room.leaseExpiresAt = Date.now() + LEASE_MS;
      granted = true;
    } else if (action === 'release' && room.ownerClientId === pairing.clientId) {
      room.ownerClientId = null;
      room.leaseExpiresAt = 0;
      room.state.playing = false;
      granted = true;
      broadcast(room, 'owner', { clientId: null });
      broadcast(room, 'state', room.state);
    }
    sendJson(response, 200, { granted, ownerClientId: room.ownerClientId });
    return true;
  }

  if (pathname === '/v1/command' && request.method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!(error instanceof RelayRequestError)) throw error;
      sendJson(response, error.status, { error: error.message });
      return true;
    }
    if (typeof body !== 'object' || body === null || !('roomId' in body) ||
      typeof body.roomId !== 'string' || !('deviceId' in body) || typeof body.deviceId !== 'string' ||
      !('clientId' in body) || typeof body.clientId !== 'string' ||
      !('command' in body) || typeof body.command !== 'object' || body.command === null ||
      !('type' in body.command) || typeof body.command.type !== 'string') {
      sendJson(response, 400, { error: 'A valid music command and pairing code are required.' });
      return true;
    }
    const pairing = getPairingFromValues(body.roomId, body.deviceId, body.clientId, response);
    if (!pairing) return true;
    const command = body.command as SyncCommand;
    if (!['play', 'pause', 'mute', 'unmute', 'volume'].includes(command.type) ||
      (command.type === 'volume' && (!Number.isInteger(command.value) || command.value! < 0 || command.value! > 200))) {
      sendJson(response, 400, { error: 'The music command is invalid.' });
      return true;
    }
    const room = getRoom(pairing.roomId);
    releaseExpiredLease(room);
    if (command.type === 'play') room.state.playing = true;
    if (command.type === 'pause') room.state.playing = false;
    if (command.type === 'mute') room.state.muted = true;
    if (command.type === 'unmute') room.state.muted = false;
    if (command.type === 'volume') room.state.volumePercent = command.value!;
    for (const [clientId, client] of room.clients) {
      if (clientId !== pairing.clientId) sendEvent(client, 'command', { ...command, senderId: pairing.clientId });
    }
    broadcast(room, 'state', room.state);
    sendJson(response, 200, { sent: true });
    return true;
  }

  sendJson(response, 404, { error: 'Not found.' });
  return true;
}

export async function closeMusicSyncRelay(): Promise<void> {
  if (mongoReady) {
    try {
      await mongoReady;
    } catch (error) {
      console.error('Unable to finish initializing the music sync database before shutdown.', error);
    }
  }
  await mongoClient?.close();
  mongoClient = undefined;
  mongoDb = undefined;
  tracksCollection = undefined;
  audioBucket = undefined;
  mongoReady = undefined;
}
