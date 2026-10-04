import {setTimeout as wait} from 'node:timers/promises';
import type {Clock, TestClock} from './index.js';
import {
    createTestClock,
    daysInMilliseconds,
    GlobalClock,
    GlobalTestClock,
    hoursInMilliseconds,
    millisecondsBetween,
    secondsToMilliseconds,
    SystemClock,
} from './index.js';

describe('@deltic/clock', () => {
    describe('clock.SystemClock', () => {
        it('should provide the system time', async () => {
            const clock = SystemClock;
            const before = Date.now();

            await wait(5); // ensure diff
            const now = clock.now();
            await wait(5); // ensure diff

            const after = Date.now();

            expect(now).toBeGreaterThan(before);
            expect(now).toBeLessThan(after);
        });

        it('should move forward on its own', async () => {
            const first = SystemClock.now();

            await wait(5); // ensure diff

            expect(SystemClock.now()).toBeGreaterThan(first);
        });
    });

    describe('clock.GlobalClock', () => {
        test('the default clock is a test clock in tests, so time is constant', async () => {
            const first = GlobalClock.now();

            await wait(5); // ensure diff

            expect(first).toEqual(GlobalClock.now());
        });

        test('the global test clock is the very clock consumers read time from', () => {
            expect(GlobalTestClock).toBe(GlobalClock);
            expect(GlobalClock).not.toBe(SystemClock);
        });

        test('moving the global test clock is observable through the global clock', () => {
            const startedAt = GlobalTestClock.now();

            try {
                GlobalTestClock.advance(daysInMilliseconds(1));

                expect(GlobalClock.now()).toBe(startedAt + daysInMilliseconds(1));
                expect(GlobalClock.date().getTime()).toBe(startedAt + daysInMilliseconds(1));
            } finally {
                // The global clock is module-level state shared by every test file in this
                // worker, restore it rather than resetting it to its creation time.
                GlobalTestClock.travelTo(startedAt);
            }

            expect(GlobalClock.now()).toBe(startedAt);
        });
    });

    describe.each([
        ['SystemClock', () => SystemClock, false],
        ['GlobalClock', () => GlobalClock, true],
        ['TestClock without a start time', () => createTestClock(), true],
        ['TestClock with a start time', () => createTestClock('2024-06-01T12:00:00.000Z'), true],
    ])('Clock contract using %s', (_name, createClock: () => Clock, timeStandsStill: boolean) => {
        let clock: Clock;

        beforeEach(() => {
            clock = createClock();
        });

        test('now() reports a finite whole number of milliseconds', () => {
            const now = clock.now();

            expect(Number.isFinite(now)).toBe(true);
            expect(Number.isInteger(now)).toBe(true);
        });

        test('date() reports a valid point in time', () => {
            const date = clock.date();

            expect(date).toBeInstanceOf(Date);
            expect(Number.isNaN(date.getTime())).toBe(false);
            expect(() => date.toISOString()).not.toThrow();
        });

        test('date() and now() report the same instant', () => {
            const date = clock.date();
            const now = clock.now();

            if (timeStandsStill) {
                expect(now).toBe(date.getTime());
            } else {
                // The system clock is read twice, so the two reads may land in different milliseconds.
                expect(now - date.getTime()).toBeLessThan(secondsToMilliseconds(1));
                expect(now - date.getTime()).toBeGreaterThanOrEqual(0);
            }
        });

        test('date() hands out a new Date on every call so callers cannot mutate the clock', () => {
            const first = clock.date();
            const second = clock.date();

            expect(first).not.toBe(second);
            expect(first.getTime()).not.toBeNaN();

            const before = clock.now();
            first.setUTCFullYear(1999);

            expect(clock.now()).toBeGreaterThanOrEqual(before);
            expect(clock.date().getUTCFullYear()).not.toBe(1999);
        });

        test('the ISO representation of date() round-trips to the same instant', () => {
            const date = clock.date();

            expect(Date.parse(date.toISOString())).toBe(date.getTime());
        });

        test('a timestamp taken from the clock survives a JSON round-trip', () => {
            // packages/event-sourcing writes both forms into message headers and asserts
            // the headers survive JSON serialisation, a non-finite time would become null.
            const date = clock.date();
            const headers = {time_of_recording: date.toISOString(), time_of_recording_ms: date.getTime()};

            expect(JSON.parse(JSON.stringify(headers))).toEqual(headers);
        });

        test('now() never moves backwards', () => {
            let previous = clock.now();

            for (let read = 0; read < 100; read++) {
                const current = clock.now();

                expect(current).toBeGreaterThanOrEqual(previous);
                previous = current;
            }
        });
    });

    describe('clock.TestClock', () => {
        it('should provide a fixed time', () => {
            const clock = createTestClock(Date.parse('04 Dec 2022 15:30:45 GMT'));

            expect(clock.now()).toBe(1670167845000);
            clock.tick();
            expect(clock.now()).toBe(1670167845001);
        });

        it('should be able to jump ahead in time', () => {
            const clock = createTestClock(Date.parse('04 Dec 2022 15:30:45 GMT'));

            expect(clock.now()).toBe(1670167845000);
            clock.travelTo(Date.parse('09 Jan 2023 18:10:12 GMT'));
            expect(clock.now()).toBe(1673287812000);
        });

        it('should be able to go back in time', () => {
            const clock = createTestClock(Date.parse('04 Dec 2022 15:30:45 GMT'));

            expect(clock.now()).toBe(1670167845000);
            clock.travelTo(Date.parse('02 Nov 2021 18:10:12 GMT'));
            expect(clock.now()).toBe(1635876612000);
        });

        it('should be able to go back in time using a date string', () => {
            const clock = createTestClock('04 Dec 2022 15:30:45 GMT');

            expect(clock.now()).toBe(1670167845000);
            clock.travelTo('02 Nov 2021 18:10:12 GMT');
            expect(clock.now()).toBe(1635876612000);
        });

        it('starts at the current system time when no start time is given', () => {
            const before = Date.now();
            const clock = createTestClock();
            const after = Date.now();

            expect(clock.now()).toBeGreaterThanOrEqual(before);
            expect(clock.now()).toBeLessThanOrEqual(after);
        });

        it('holds time still until it is moved', async () => {
            const clock = createTestClock();
            const startedAt = clock.now();

            await wait(5); // ensure the system clock moved on

            expect(clock.now()).toBe(startedAt);
            expect(clock.date().getTime()).toBe(startedAt);
        });

        it('advances by the exact increment it is given', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.advance(hoursInMilliseconds(2));

            expect(clock.date().toISOString()).toBe('2024-06-01T14:00:00.000Z');
        });

        it('accumulates repeated advances without drift', () => {
            // Mirrors how packages/messaging steps a test clock through a throttling window.
            const clock = createTestClock('2024-01-01T00:00:00.000Z');
            const startedAt = clock.now();

            for (let second = 0; second < 60; second++) {
                clock.advance(secondsToMilliseconds(1));
            }

            expect(clock.now()).toBe(startedAt + secondsToMilliseconds(60));
            expect(clock.date().toISOString()).toBe('2024-01-01T00:01:00.000Z');
        });

        it('treats advancing by zero milliseconds as standing still', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.advance(0);

            expect(clock.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
        });

        it('moves back in time when advanced by a negative increment', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.advance(-hoursInMilliseconds(3));

            expect(clock.date().toISOString()).toBe('2024-06-01T09:00:00.000Z');
        });

        it('reports every movement through both now() and date()', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.tick();
            expect(clock.date().getTime()).toBe(clock.now());

            clock.advance(daysInMilliseconds(1));
            expect(clock.date().getTime()).toBe(clock.now());

            clock.travelTo('2020-02-29T23:59:59.999Z');
            expect(clock.date().getTime()).toBe(clock.now());
            expect(clock.date().toISOString()).toBe('2020-02-29T23:59:59.999Z');
        });

        it('returns to its start time when reset', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.tick();
            clock.advance(daysInMilliseconds(30));
            clock.travelTo('1999-12-31T23:00:00.000Z');
            clock.reset();

            expect(clock.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
        });

        it('stays at its start time when reset repeatedly', () => {
            const clock = createTestClock('2024-06-01T12:00:00.000Z');

            clock.advance(daysInMilliseconds(1));
            clock.reset();
            clock.reset();

            expect(clock.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
        });

        it('resets to the start time it was created with, not to the current system time', async () => {
            const clock = createTestClock();
            const startedAt = clock.now();

            clock.advance(daysInMilliseconds(1));
            await wait(5); // ensure the system clock moved on
            clock.reset();

            expect(clock.now()).toBe(startedAt);
        });

        it('keeps the time of separate test clocks independent', () => {
            const first = createTestClock('2024-06-01T12:00:00.000Z');
            const second = createTestClock('2024-06-01T12:00:00.000Z');

            first.advance(daysInMilliseconds(1));

            expect(second.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
            expect(first.date().toISOString()).toBe('2024-06-02T12:00:00.000Z');

            second.reset();

            expect(first.date().toISOString()).toBe('2024-06-02T12:00:00.000Z');
        });
    });

    describe('clock.TestClock time arithmetic', () => {
        it('advances in UTC milliseconds, unaffected by a daylight saving transition', () => {
            // European summer time starts at 01:00 UTC on 2024-03-31.
            const clock = createTestClock('2024-03-31T00:30:00.000Z');

            clock.advance(hoursInMilliseconds(2));

            expect(clock.date().toISOString()).toBe('2024-03-31T02:30:00.000Z');
            expect(millisecondsBetween(Date.parse('2024-03-31T00:30:00.000Z'), clock.now())).toBe(
                hoursInMilliseconds(2),
            );
        });

        it('advances across a leap day', () => {
            const clock = createTestClock('2024-02-28T12:00:00.000Z');

            clock.advance(daysInMilliseconds(1));

            expect(clock.date().toISOString()).toBe('2024-02-29T12:00:00.000Z');
        });

        it('advances across a year boundary', () => {
            const clock = createTestClock('2024-12-31T23:59:59.000Z');

            clock.advance(secondsToMilliseconds(1));

            expect(clock.date().toISOString()).toBe('2025-01-01T00:00:00.000Z');
        });

        it('reads a start time without a zone designator as local time', () => {
            const clock = createTestClock('04 Dec 2022 15:30:45');
            const date = clock.date();

            expect(date.getHours()).toBe(15);
            expect(date.getMinutes()).toBe(30);
            expect(date.getSeconds()).toBe(45);
        });

        it('reads a start time with a zone designator as that zone', () => {
            const clock = createTestClock('2022-12-04T15:30:45.000Z');

            expect(clock.now()).toBe(Date.UTC(2022, 11, 4, 15, 30, 45));
            expect(clock.date().toISOString()).toBe('2022-12-04T15:30:45.000Z');
        });

        it('accepts the epoch as a start time', () => {
            const clock = createTestClock(0);

            expect(clock.now()).toBe(0);
            expect(clock.date().toISOString()).toBe('1970-01-01T00:00:00.000Z');
        });

        it('accepts a start time before the epoch', () => {
            const clock = createTestClock('1969-07-20T20:17:00.000Z');

            expect(clock.now()).toBeLessThan(0);
            expect(clock.date().toISOString()).toBe('1969-07-20T20:17:00.000Z');
        });
    });

    describe('clock.TestClock with an unusable time', () => {
        it.each([
            // A unix timestamp in seconds, a common mistake, does not parse as a date string.
            ['a unix timestamp in seconds', '1670167845'],
            ['an empty string', ''],
            ['an out of range date', '2024-13-45'],
            ['an out of range time', '1 Jan 2024 25:00:00 GMT'],
        ])('refuses %s as a start time', (_name, start: string) => {
            expect(() => createTestClock(start)).toThrow(/as a point in time/);
        });

        it('names the value it could not interpret', () => {
            expect(() => createTestClock('1670167845')).toThrow('Unable to interpret "1670167845" as a point in time');
        });

        it('refuses a start time that is not a finite number', () => {
            expect(() => createTestClock(Number.NaN)).toThrow(/as a point in time/);
            expect(() => createTestClock(Number.POSITIVE_INFINITY)).toThrow(/as a point in time/);
        });

        it('refuses to travel to a time string it cannot parse', () => {
            const clock: TestClock = createTestClock('2024-06-01T12:00:00.000Z');

            expect(() => clock.travelTo('2024-13-45')).toThrow(/as a point in time/);
        });

        it('stays at the time it already reported when time travel is refused', () => {
            const clock: TestClock = createTestClock('2024-06-01T12:00:00.000Z');
            const before = clock.now();

            expect(() => clock.travelTo('')).toThrow();

            expect(clock.now()).toBe(before);
            expect(clock.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
        });

        it('refuses to advance by an increment that is not a finite number', () => {
            const clock: TestClock = createTestClock('2024-06-01T12:00:00.000Z');

            expect(() => clock.advance(Number.NaN)).toThrow(/Unable to advance a clock/);
            expect(clock.date().toISOString()).toBe('2024-06-01T12:00:00.000Z');
        });
    });

    describe('clock.Helpers', () => {
        it('should calculate the number of milliseconds in a day', () => {
            expect(daysInMilliseconds(1)).toBe(86_400_000);
            expect(daysInMilliseconds(7)).toBe(604_800_000);
        });

        it('should calculate the number of milliseconds in a number of seconds', () => {
            expect(secondsToMilliseconds(0)).toBe(0);
            expect(secondsToMilliseconds(1)).toBe(1_000);
            expect(secondsToMilliseconds(30)).toBe(30_000);
            expect(secondsToMilliseconds(0.5)).toBe(500);
            expect(secondsToMilliseconds(-5)).toBe(-5_000);
        });

        it('should calculate the number of milliseconds in a number of hours', () => {
            expect(hoursInMilliseconds(0)).toBe(0);
            expect(hoursInMilliseconds(1)).toBe(3_600_000);
            expect(hoursInMilliseconds(0.5)).toBe(1_800_000);
            expect(hoursInMilliseconds(-2)).toBe(-7_200_000);
        });

        it('should calculate zero and negative day durations', () => {
            expect(daysInMilliseconds(0)).toBe(0);
            expect(daysInMilliseconds(-1)).toBe(-86_400_000);
        });

        it('the duration helpers agree with each other', () => {
            expect(secondsToMilliseconds(3_600)).toBe(hoursInMilliseconds(1));
            expect(hoursInMilliseconds(24)).toBe(daysInMilliseconds(1));
            expect(secondsToMilliseconds(86_400 * 7)).toBe(daysInMilliseconds(7));
        });

        it('should calculate time between dates', () => {
            expect(millisecondsBetween(5, 8)).toEqual(3);
            expect(() => millisecondsBetween(8, 5)).toThrow(new Error('Start time must be earlier than end time'));
        });

        it('should report no elapsed time between an instant and itself', () => {
            expect(millisecondsBetween(5, 5)).toBe(0);
        });

        it('should measure the time elapsed between two clock readings', () => {
            const clock = createTestClock('2024-01-01T00:00:00.000Z');
            const startedAt = clock.now();

            clock.advance(hoursInMilliseconds(3));

            expect(millisecondsBetween(startedAt, clock.now())).toBe(hoursInMilliseconds(3));
        });

        it('should measure elapsed time across the epoch', () => {
            const startedAt = Date.parse('1969-12-31T23:59:59.000Z');
            const endedAt = Date.parse('1970-01-01T00:00:01.000Z');

            expect(millisecondsBetween(startedAt, endedAt)).toBe(secondsToMilliseconds(2));
        });
    });
});
