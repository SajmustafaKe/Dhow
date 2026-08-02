import fs from 'fs';
import path from 'path';
import type { DhowEvent } from '@x/shared/dist/events.js';
import { WorkDir } from '../config/config.js';
import type { IMonotonicallyIncreasingIdGenerator } from '../application/lib/id-gen.js';
import container from '../di/container.js';

export const EVENTS_DIR = path.join(WorkDir, 'events');
export const PENDING_DIR = path.join(EVENTS_DIR, 'pending');
export const DONE_DIR = path.join(EVENTS_DIR, 'done');

/**
 * Write a DhowEvent to the events/pending/ directory. The filename is the
 * monotonically increasing ID so events sort by creation order. Producers
 * (gmail/calendar sync) call this in chronological order within a batch.
 */
export async function createEvent(event: Omit<DhowEvent, 'id'>): Promise<void> {
    fs.mkdirSync(PENDING_DIR, { recursive: true });

    const idGen = container.resolve<IMonotonicallyIncreasingIdGenerator>('idGenerator');
    const id = await idGen.next();

    const fullEvent: DhowEvent = { id, ...event };
    const filePath = path.join(PENDING_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fullEvent, null, 2), 'utf-8');
}

export function ensureEventDirs(): void {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
}
