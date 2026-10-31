import type { HealthAdapter, HealthSelection } from './types';

// Web and environments without a platform implementation do not access health data.
export function createHealthAdapter(): HealthAdapter {
  return {
    async availability() { return { status: 'unsupported', source: null, reason: 'unsupported' }; },
    async connect(selection: HealthSelection) { return { steps: selection.steps ? 'unsupported' : 'not_selected', workouts: selection.workouts ? 'unsupported' : 'not_selected' }; },
    async read() { throw new Error('HEALTH_UNSUPPORTED'); },
    async openSettings() {},
  };
}
