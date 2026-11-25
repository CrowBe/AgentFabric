import { GatewayError, type CompositeSourceConfig } from '../types/index.js';

export function validateComposite(config: CompositeSourceConfig) {
  if (!config.steps.length || config.steps.length > Math.min(100, config.maxSteps ?? 10)
    || new Set(config.steps.map(step => step.id)).size !== config.steps.length) {
    throw new GatewayError('INVALID_INPUT', 'Composite steps exceed the configured bound or contain duplicate IDs');
  }
}

export async function executeComposite(
  config: CompositeSourceConfig,
  args: Record<string, unknown>,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  validateComposite(config);
  const steps: Record<string, unknown> = Object.create(null);
  const bindings = { input: args, args, steps };
  function resolve(expression: string) {
    const path = expression.trim().split('.');
    if (!['input', 'args', 'steps'].includes(path[0])) path.unshift('input');
    let current: unknown = bindings;
    for (const key of path) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
        throw new GatewayError('INVALID_INPUT', 'Unknown composite template reference');
      }
      current = Reflect.get(current, key);
    }
    return current;
  }
  function render(template: unknown): unknown {
    if (typeof template === 'string') {
      const whole = template.match(/^\{\{([^{}]+)\}\}$/);
      if (whole) return resolve(whole[1]);
      return template.replaceAll(/\{\{([^{}]+)\}\}/g, (_, ref: string) => {
        const value = resolve(ref);
        return typeof value === 'string' ? value : JSON.stringify(value);
      });
    }
    if (Array.isArray(template)) return template.map(render);
    if (template && typeof template === 'object') {
      return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, render(value)]));
    }
    return template;
  }
  let result: unknown;
  for (const step of config.steps) {
    result = await call(step.capability, render(step.argumentsTemplate) as Record<string, unknown>);
    steps[step.id] = result;
  }
  return config.outputTemplate === undefined ? result : render(config.outputTemplate);
}
