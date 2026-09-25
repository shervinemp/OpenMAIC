import { test as base } from '@playwright/test';
import { MockApi } from './mock-api';

type Fixtures = {
  mockApi: MockApi;
  readinessGate: void;
};

export const test = base.extend<Fixtures>({
  mockApi: async ({ page }, use) => {
    const mockApi = new MockApi(page);
    // Always mock server-providers - called on every page load by root layout
    await mockApi.mockServerProviders();
    await use(mockApi);
  },
  // Auto fixture: every test gets the readiness pre-flight mocked. There is
  // no media stack in e2e, and the gate must never block the flows under
  // test. Auto because many specs submit from home without destructuring
  // mockApi - a lazy fixture would silently leave the real (blocking)
  // endpoint live for them.
  readinessGate: [
    async ({ page }, use) => {
      await new MockApi(page).mockGenerationReadiness();
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
