/**
 * Venue config loader and validator.
 * Loads YAML venue configs and validates required fields.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import type { VenueConfig } from './types';

// Use a simple YAML parser since we don't want to add js-yaml as a dependency.
// Venue configs are simple enough for a regex-based approach.
// If configs get more complex, switch to js-yaml.

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let currentKey = '';
  let currentObj: Record<string, unknown> | null = null;
  let indent = 0;
  const stack: Array<{ key: string; obj: Record<string, unknown>; indent: number }> = [];

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const leadingSpaces = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Handle key: value pairs
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim();

      // Pop stack to find correct parent
      while (stack.length > 0 && leadingSpaces <= stack[stack.length - 1].indent) {
        stack.pop();
      }

      const target = stack.length > 0 ? stack[stack.length - 1].obj : result;

      if (value === '' || value === '|') {
        // Nested object or block scalar
        const nested: Record<string, unknown> = {};
        target[key] = nested;
        stack.push({ key, obj: nested, indent: leadingSpaces });
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        const inner = value.slice(1, -1);
        target[key] = inner.split(',').map(s => {
          const t = s.trim().replace(/^["']|["']$/g, '');
          const n = Number(t);
          return isNaN(n) ? (t === 'null' ? null : t) : n;
        });
      } else if (value.startsWith('"') || value.startsWith("'")) {
        target[key] = value.replace(/^["']|["']$/g, '');
      } else if (value === 'null' || value === '~') {
        target[key] = null;
      } else if (value === 'true') {
        target[key] = true;
      } else if (value === 'false') {
        target[key] = false;
      } else if (!isNaN(Number(value))) {
        target[key] = Number(value);
      } else {
        target[key] = value;
      }
    }
  }

  return result;
}

export function loadVenueConfig(filePath: string): VenueConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Venue config not found: ${filePath}`);
  }
  const text = readFileSync(filePath, 'utf-8');
  const raw = parseSimpleYaml(text) as Record<string, unknown>;

  // Validate required fields
  const required = ['venue_id', 'name', 'api_base', 'paper_invitation', 'review_invitation', 'score_parse_regex'];
  for (const field of required) {
    if (!raw[field]) {
      throw new Error(`Venue config missing required field: ${field} (in ${filePath})`);
    }
  }

  if (!raw.dimensions || typeof raw.dimensions !== 'object') {
    throw new Error(`Venue config missing 'dimensions' object (in ${filePath})`);
  }

  // Validate dimensions
  const dims = raw.dimensions as Record<string, Record<string, unknown>>;
  for (const [name, dim] of Object.entries(dims)) {
    if (!dim.field) throw new Error(`Dimension '${name}' missing 'field' (in ${filePath})`);
    if (!dim.scale || !Array.isArray(dim.scale) || dim.scale.length !== 2) {
      throw new Error(`Dimension '${name}' has invalid 'scale' — expected [min, max] (in ${filePath})`);
    }
    const [min, max] = dim.scale as [number, number];
    if (typeof min !== 'number' || typeof max !== 'number' || min >= max) {
      throw new Error(`Dimension '${name}' scale [${min}, ${max}] is invalid (in ${filePath})`);
    }
  }

  return {
    venue_id: raw.venue_id as string,
    name: raw.name as string,
    api_base: raw.api_base as string,
    status: (raw.status as 'validated' | 'draft') || 'draft',
    dimensions: Object.fromEntries(
      Object.entries(dims).map(([name, dim]) => [
        name,
        {
          field: dim.field as string,
          scale: dim.scale as [number, number],
          labels: (dim.labels as string[] | null) || null,
          skillDimension: dim.skillDimension as string | undefined,
        },
      ])
    ),
    score_parse_regex: raw.score_parse_regex as string,
    paper_invitation: raw.paper_invitation as string,
    review_invitation: raw.review_invitation as string,
    score_bands: raw.score_bands as VenueConfig['score_bands'],
  };
}

export function loadAllVenueConfigs(venuesDir: string, includeDrafts = false): VenueConfig[] {
  if (!existsSync(venuesDir)) return [];
  const files = readdirSync(venuesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const configs: VenueConfig[] = [];

  for (const file of files) {
    const config = loadVenueConfig(join(venuesDir, file));
    if (config.status === 'draft' && !includeDrafts) continue;
    configs.push(config);
  }

  return configs;
}
