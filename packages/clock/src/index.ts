export interface Clock {
    now(): number;
    date(): Date;
}

export const SystemClock: Clock = {
    now: () => Date.now(),
    date: () => new Date(),
};

export interface TestClock extends Clock {
    tick(): void;
    advance(increment: number): void;
    travelTo(laterTime: number | string): void;
    reset(): void;
}

export const GlobalClock = process.env.NODE_ENV === 'test' ? createTestClock() : SystemClock;
export const GlobalTestClock = process.env.NODE_ENV === 'test' ? (GlobalClock as TestClock) : createTestClock();

/**
 * Interpret a point in time, refusing anything that would leave a clock unusable.
 *
 * `Date.parse` reports a string it cannot interpret as `NaN`, which is a valid `number` and so
 * would be stored without complaint. A clock holding `NaN` reports an `Invalid Date`, which only
 * fails much later, in whichever consumer first formats it.
 */
function interpretTime(value: number | string): number {
    const time = typeof value === 'number' ? value : Date.parse(value);

    if (!Number.isFinite(time)) {
        throw new Error(`Unable to interpret ${JSON.stringify(value)} as a point in time`);
    }

    return time;
}

export function createTestClock(start: number | string = Date.now()): TestClock {
    let now = interpretTime(start);
    const originalNow = now;

    return {
        now: () => now,
        advance: (increment: number) => {
            if (!Number.isFinite(increment)) {
                throw new Error(`Unable to advance a clock by ${JSON.stringify(increment)}`);
            }

            return (now += increment);
        },
        date: () => new Date(now),
        tick: () => ++now,
        travelTo: (newTime: number | string) => {
            now = interpretTime(newTime);
        },
        reset: () => {
            now = originalNow;
        },
    };
}

/**
 * Convert number of seconds into equivalent number of milliseconds
 */
export function secondsToMilliseconds(seconds: number): number {
    return seconds * 1000;
}

/**
 * Calculate how many milliseconds would be in the given number of days
 */
export function daysInMilliseconds(numberOfDays: number) {
    // There are 86,400,000 milliseconds in one day
    return 86_400_000 * numberOfDays;
}

/**
 * Calculate how many milliseconds would be in the given number of hours
 */
export function hoursInMilliseconds(numberOfHours: number) {
    // There are 3600,000 milliseconds in one hour
    return 3_600_000 * numberOfHours;
}

/**
 * Calculate how many milliseconds elapsed between startDate and endDate.
 *
 * @param startDate Must be earlier or equal to endDate
 * @param endDate Must be later or equal to startDate
 */
export function millisecondsBetween(startDate: number, endDate: number) {
    if (startDate > endDate) {
        throw new Error('Start time must be earlier than end time');
    }

    return endDate - startDate;
}
