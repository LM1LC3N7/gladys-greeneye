// The parts of ~/code/ref/gladys-testkit this repository uses, copied so that
// the tests run anywhere (GitHub CI included): the virtual and the real clock,
// the spy that measures a period.
export { testClock, realClock, spyOn, measurePeriod, settle } from './clock.mjs';
