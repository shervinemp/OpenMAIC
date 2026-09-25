/**
 * Regression (#784): disabling the currently-selected media/TTS/web-search
 * provider must switch the active selection away from that provider. Otherwise
 * removing a token plan (which disables its providers) leaves the app pointed
 * at a disabled provider with an empty key, and the next generation fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('disabling the active provider switches selection away', () => {
  beforeEach(() => {
    // Reset selections to known non-default providers per test below.
    useSettingsStore.setState({
      imageProviderId: 'seedream',
      videoProviderId: 'seedance',
      ttsProviderId: 'browser-native-tts',
      webSearchProviderId: 'tavily',
    });
  });

  it('image: disabling the selected provider falls back to seedream', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');

    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('seedream');
  });

  it('image: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      imageProviderId: 'seedream',
      imageGenerationEnabled: true,
      imageProvidersConfig: {
        ...state.imageProvidersConfig,
        seedream: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        'openai-image': { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setImageProviderConfig('seedream', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().imageProviderId).not.toBe('seedream');
    expect(useSettingsStore.getState().imageGenerationEnabled).toBe(false);
  });

  it('image: disabling a NON-selected provider leaves the selection alone', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('seedream');
    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('seedream');
  });

  it('video: disabling the selected provider falls back to seedance', () => {
    const s = useSettingsStore.getState();
    s.setVideoProvider('kling');
    expect(useSettingsStore.getState().videoProviderId).toBe('kling');

    s.setVideoProviderConfig('kling', { enabled: false });
    expect(useSettingsStore.getState().videoProviderId).toBe('seedance');
  });

  it('video: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'seedance',
      videoGenerationEnabled: true,
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        seedance: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        kling: { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setVideoProviderConfig('seedance', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().videoProviderId).not.toBe('seedance');
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(false);
  });

  it('video: an unconfigured ComfyUI provider is never chosen as the fallback', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'kling',
      videoGenerationEnabled: true,
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        kling: { apiKey: 'k-test', baseUrl: '', enabled: true },
        'comfyui-video': { apiKey: '', baseUrl: '', enabled: true },
      },
    }));

    const s = useSettingsStore.getState();
    s.setVideoProviderConfig('kling', { enabled: false });
    // Every keyed provider is empty and ComfyUI has no base URL: fall back to
    // the registry default rather than blind-selecting a keyless local server.
    expect(useSettingsStore.getState().videoProviderId).toBe('seedance');
  });

  it('video: a configured ComfyUI provider is a valid fallback target', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'kling',
      videoGenerationEnabled: true,
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        kling: { apiKey: 'k-test', baseUrl: '', enabled: true },
        'comfyui-video': { apiKey: '', baseUrl: 'http://localhost:8188', enabled: true },
      },
    }));

    const s = useSettingsStore.getState();
    s.setVideoProviderConfig('kling', { enabled: false });
    // Keyed providers have no keys; ComfyUI is the only actually-configured
    // target, so it is selected even though it is keyless.
    expect(useSettingsStore.getState().videoProviderId).toBe('comfyui-video');
  });

  it('tts: disabling the selected provider falls back to browser TTS', () => {
    const s = useSettingsStore.getState();
    s.setTTSProvider('openai-tts');
    expect(useSettingsStore.getState().ttsProviderId).toBe('openai-tts');

    s.setTTSProviderConfig('openai-tts', { enabled: false });
    expect(useSettingsStore.getState().ttsProviderId).toBe('browser-native-tts');
  });

  it('web search: disabling the selected provider falls back to tavily', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('bocha');
    expect(useSettingsStore.getState().webSearchProviderId).toBe('bocha');

    s.setWebSearchProviderConfig('bocha', { enabled: false });
    expect(useSettingsStore.getState().webSearchProviderId).toBe('tavily');
  });

  it('enabling/other edits do NOT force a switch away', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    s.setImageProviderConfig('openai-image', { apiKey: 'sk-x', enabled: true });
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');
  });

  it('enabling video generation does not throw on an undefined config entry', () => {
    // Regression: videoProvidersConfig entries added after a user's persisted
    // state was saved (e.g. comfyui-video) used to be filled with `undefined`,
    // and Object.values(cfg).some((c) => c.isServerConfigured ...) threw.
    useSettingsStore.setState({
      videoProviderId: 'seedance',
      videoGenerationEnabled: false,
      videoProvidersConfig: {
        seedance: { apiKey: '', baseUrl: '', enabled: false, isServerConfigured: false },
        'comfyui-video': undefined as never,
      } as never,
    });
    expect(() =>
      useSettingsStore.getState().setVideoGenerationEnabled(true),
    ).not.toThrow();
    // No usable provider → the toggle stays off.
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(false);
  });

  it('enabling generation works with a keyless provider that has a base URL', () => {
    // Keyless local providers (ComfyUI) count as usable once baseUrl is set.
    useSettingsStore.setState({
      videoProviderId: 'comfyui-video',
      videoGenerationEnabled: false,
      videoProvidersConfig: {
        'comfyui-video': { apiKey: '', baseUrl: 'http://localhost:8188', enabled: true },
      } as never,
    });
    useSettingsStore.getState().setVideoGenerationEnabled(true);
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(true);
  });

  it('selecting a keyless provider seeds its default base URL', () => {
    useSettingsStore.setState((state) => ({
      imageProvidersConfig: {
        ...state.imageProvidersConfig,
        'comfyui-image': { apiKey: '', baseUrl: '', enabled: false },
      },
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        'comfyui-video': { apiKey: '', baseUrl: '', enabled: false },
      },
    }));
    const s = useSettingsStore.getState();
    s.setImageProvider('comfyui-image');
    s.setVideoProvider('comfyui-video');
    expect(useSettingsStore.getState().imageProvidersConfig['comfyui-image'].baseUrl).toBe(
      'http://localhost:8188',
    );
    expect(useSettingsStore.getState().videoProvidersConfig['comfyui-video'].baseUrl).toBe(
      'http://localhost:8188',
    );
  });

  it('selecting a keyed provider does not seed a base URL', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    expect(useSettingsStore.getState().imageProvidersConfig['openai-image'].baseUrl).toBe('');
  });
});
