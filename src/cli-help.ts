type Row = readonly [label: string, description: string];

const commands: Row[] = [
  ['stdio', 'Connect a local MCP client'],
  ['start', 'Host through Cloudflare'],
  ['stop', 'Stop hosting'],
  ['status', 'Show hosting status'],
  ['restart', 'Restart hosting'],
  ['install-browser', 'Install Chrome for Markdown and HTML'],
];

export const commandNames = commands.map(([name]) => name);

const state: Row = ['--state-dir <path>', 'Directory for settings and print history'];
const printerOptions: Row[] = [
  state,
  ['--chrome <path>', 'Chrome or Chromium executable'],
  ['--sumatra-pdf <path>', 'SumatraPDF executable on Windows'],
];
const outputOptions: Row[] = [
  ['--json', 'Print results and errors as JSON'],
  ['-h, --help', 'Show command help'],
];

function rows(entries: Row[], width: number): string {
  const column = Math.max(...entries.map(([label]) => label.length)) + 4;
  return entries.map(([label, description]) => {
    const stacked = width - column < 24;
    const indent = stacked ? 4 : column;
    const lines: string[] = [];
    let line = '';
    for (const word of description.split(' ')) {
      if (line && indent + line.length + 1 + word.length > width) { lines.push(line); line = ''; }
      line += `${line ? ' ' : ''}${word}`;
    }
    if (line) lines.push(line);
    if (stacked) return `  ${label}\n${lines.map(text => ' '.repeat(indent) + text).join('\n')}`;
    return `  ${label}`.padEnd(column) + lines.join(`\n${' '.repeat(indent)}`);
  }).join('\n');
}

export function renderHelp(command?: string): string {
  const width = Math.max(40, Math.min(process.stdout.columns || 80, 100));
  const section = (title: string, entries: Row[]) => `${title}\n${rows(entries, width)}`;
  const usage = `Usage\n  npx printgo${command ? ` ${command}` : ' <command>'} [options]`;
  if (!command) return [
    'PrintGo-MCP',
    usage,
    section('Commands', commands),
    section('Options', [['-h, --help', 'Show help'], ['-v, --version', 'Show version']]),
    'Examples\n  npx printgo stdio\n  npx printgo start\n  npx printgo start --help',
    'Commands: printgo or printgo-mcp.\nUse <command> --help for options and examples.',
    '',
  ].join('\n\n');

  const sections = [`PrintGo-MCP · ${command}`, usage];
  if (command === 'stdio') {
    sections.push(
      'Connect locally over stdin/stdout. No Cloudflare setup required.',
      section('Printer options', printerOptions),
      section('Options', [['-h, --help', 'Show command help']]),
      'Example\n  npx printgo stdio --state-dir ./printer-state',
      'Notes\n  • Configure your MCP client to launch this command.\n  • The process stops when the client closes its connection.',
    );
  } else if (command === 'start' || command === 'restart') {
    sections.push(
      command === 'start' ? 'Start hosting, or show connection details if already running.' : 'Restart hosting with your saved settings or new options.',
      section('Tunnel options', [
        ['--quick', 'Use a temporary Cloudflare URL'],
        ['--custom-domain-with-cf', 'Set up a domain in your Cloudflare account'],
        ['--hostname <host>', 'Public hostname, e.g. printer.example.com'],
        ['--tunnel-name <name>', 'Name for the tunnel you create'],
        ['--tunnel-id <uuid>', 'Connect an existing named tunnel'],
        ['--credentials-file <path>', 'Credentials for the named tunnel'],
        ['--tunnel-token-file <path>', 'Token for a dashboard-managed tunnel'],
      ]),
      section('Hosting options', [
        ['--port <port>', 'Local port (default: automatic)'],
        ['--startup-timeout <seconds>', 'Connection timeout (default: 90)'],
        ['--cloudflared <path>', 'Path to a cloudflared executable'],
        ['--no-download', 'Require an installed cloudflared'],
        ['-y, --yes', 'Allow downloading cloudflared if missing'],
      ]),
      section('Printer options', printerOptions),
      section('Output options', outputOptions),
      `Examples\n  npx printgo ${command} --quick\n  npx printgo ${command} --custom-domain-with-cf printer.example.com`,
      'Notes\n  • Quick Tunnel URLs change each time hosting starts.\n  • Named tunnel settings are saved for future starts.\n  • Token tunnels need --port to match the Cloudflare service port.',
    );
  } else {
    sections.push(
      {
        status: 'Show hosting status without revealing credentials.',
        stop: 'Stop the background server and its Cloudflare tunnel.',
        'install-browser': 'Install or update Chrome for Markdown and HTML printing.',
      }[command]!,
      section('Options', [state, ...outputOptions]),
      `Example\n  npx printgo ${command}${command === 'status' ? ' --json' : ''}`,
    );
  }
  return sections.join('\n\n') + '\n';
}
