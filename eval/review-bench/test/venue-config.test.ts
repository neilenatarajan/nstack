import { describe, test, expect } from 'bun:test';
import { loadVenueConfig, parseSimpleYaml } from '../src/venue-config';
import { join } from 'path';

const VENUES_DIR = join(import.meta.dir, '..', 'venues');

describe('parseSimpleYaml', () => {
  test('parses key-value pairs', () => {
    const result = parseSimpleYaml('name: "ICLR 2024"\nstatus: validated');
    expect(result.name).toBe('ICLR 2024');
    expect(result.status).toBe('validated');
  });

  test('parses inline arrays', () => {
    const result = parseSimpleYaml('scale: [1, 4]');
    expect(result.scale).toEqual([1, 4]);
  });

  test('parses null values', () => {
    const result = parseSimpleYaml('labels: null');
    expect(result.labels).toBeNull();
  });

  test('skips comments', () => {
    const result = parseSimpleYaml('# comment\nname: test');
    expect(result.name).toBe('test');
  });
});

describe('loadVenueConfig', () => {
  test('loads ICLR 2024 config', () => {
    const config = loadVenueConfig(join(VENUES_DIR, 'iclr2024.yaml'));
    expect(config.venue_id).toBe('ICLR.cc/2024/Conference');
    expect(config.name).toBe('ICLR 2024');
    expect(config.status).toBe('validated');
    expect(config.dimensions.overall).toBeDefined();
    expect(config.dimensions.overall.scale).toEqual([1, 10]);
    expect(config.dimensions.soundness).toBeDefined();
    expect(config.dimensions.soundness.scale).toEqual([1, 4]);
  });

  test('throws on missing file', () => {
    expect(() => loadVenueConfig('/nonexistent.yaml')).toThrow('not found');
  });

  test('draft configs load correctly', () => {
    const config = loadVenueConfig(join(VENUES_DIR, 'neurips2024.yaml'));
    expect(config.status).toBe('draft');
  });
});
