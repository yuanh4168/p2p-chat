import chalk from 'chalk';

export function formatString(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key] !== undefined ? vars[key] : match;
    return chalk.yellow(val);
  });
}