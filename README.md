# PrintGo-MCP

Use your computer's printers through MCP, locally over stdio or remotely through Cloudflare.
The npm package is `printgo`. Both `printgo` and `printgo-mcp` run the same CLI.

Requires Node.js 22.12+ and a printer configured in your operating system:

- **macOS / Linux:** CUPS (`lp`, `lpstat`, `lpoptions`, `cancel`).
- **Windows:** PowerShell and [SumatraPDF](https://www.sumatrapdfreader.org/) for PDF printing.
- **Markdown / HTML:** Chrome or Chromium. Run `install-browser` if needed.

## Setup

This package is not published yet. From a source checkout:

```sh
npm install
npm run build
```

Add it to your MCP client:

```json
{
  "mcpServers": {
    "printer": {
      "command": "node",
      "args": ["/absolute/path/to/printgo/dist/cli.js", "stdio"]
    }
  }
}
```

The client starts and stops the process. Local use needs no Cloudflare setup or password.

## Remote access

```sh
node dist/cli.js start
```

This starts a background server and Cloudflare tunnel. Connect your MCP client to
its printed URL with `Authorization: Bearer <password>`.
Anyone with that password can print and cancel jobs. Cloudflare proxies the traffic.

The CLI asks before downloading a missing `cloudflared`. Use `--yes` to approve
installation in scripts, or `--no-download` to require an existing copy.

```sh
node dist/cli.js status
node dist/cli.js stop
node dist/cli.js restart

# Use a domain you manage through Cloudflare:
node dist/cli.js start --custom-domain-with-cf printer.example.com
```

Quick Tunnel URLs change on restart; named tunnel settings are saved.
Use `start --help` for existing tunnels, token files, and other hosting options.
Use `--json` for script output.

## SDK

Install from your checkout with `npm install /path/to/printgo`.

Serve local MCP in your own process:

```ts
import { servePrinterStdio } from 'printgo';

servePrinterStdio();
```

The returned handle has a `close()` method for shutdown.

For embedding, `createPrinterMcpServer(options?)` returns an unconnected MCP server.
`createPrinterHttpServer({ password, ...options })` provides `listen()`, `close()`,
and `setPublicURL()`. It binds to loopback and requires a secret of at least 32 characters.
Neither starts a tunnel. Both accept `stateDir`, `adapter`, `assetDownloader`,
`sumatraPdfPath`, and `browserExecutablePath`. A custom downloader must enforce its
own URL, size, and timeout checks.

Connect to HTTP with the typed client:

```ts
import { connectPrinter } from 'printgo';

const printer = await connectPrinter({
  mcpConnectionURL: process.env.PRINTER_URL!,
  password: process.env.PRINTER_PASSWORD!,
});
try {
  const [selected] = await printer.listPrinters();
  if (!selected) throw new Error('No printers configured.');
  await printer.sendPrintCommand({
    printerId: selected.id,
    assetUrl: 'https://example.com/invoice.pdf',
    settings: { copies: 1, paperSize: 'A4' },
    idempotencyKey: 'invoice-123',
  });
} finally {
  await printer.close();
}
```

For stdio, pass `{ transport: new StdioClientTransport({ command, args }) }` instead.
Import that transport from `@modelcontextprotocol/client/stdio` in your application.
The client connects and closes the transport for you.

Hosting is a separate import:

```ts
import { start, stop, status, restart } from 'printgo/hosting';

const connection = await start({ downloadCloudflared: true });
```

That entry point also exports `configureCloudflare` and `ensureCloudflared`.

## Printer tools

| Tool | Purpose |
| --- | --- |
| `listPrinters` | List configured printers |
| `getPrinterCapabilities` | Read driver options |
| `checkPrinterStatus` | Check a printer's queue |
| `sendPrintCommand` | Print PDF, PNG, JPEG, or UTF-8 text from an HTTPS URL |
| `printMarkup` | Print Markdown or HTML from `content` or an HTTPS `assetUrl` |
| `getPrintJobStatus` | Look up a job created by this server |
| `cancelPrintJob` | Cancel one of those jobs |

- Print settings include copies, page ranges, paper size, orientation, duplex, color, and scaling.
- Reuse the same `idempotencyKey` and arguments when retrying. A new key can print another copy.
- File downloads are limited to 10 MiB. Markup accepts 32 KiB inline or 1 MiB by URL.
- Asset URLs must be public HTTPS; private addresses and local files are blocked. HTML scripts are disabled.
- Use `assetType: 'text'` for extensionless text. Convert Office documents to PDF first.
- Job status reflects the print queue, not confirmation that paper came out.

State is stored in `~/.printgo`. Override it with `--state-dir`, SDK
`stateDir`, or `PRINTGO_HOME`. Use a separate directory for each active
server; job history and retry keys are stored there.

## Development

```sh
npm test
npm run typecheck
npm pack --dry-run
```

Tests use fake printers and tunnels. Rendering tests use a local browser; set
`REQUIRE_CHROMIUM_TESTS=1` to fail if none is installed. `npm run smoke:tunnel`
checks a real Quick Tunnel without printing.

MIT licensed. Bundled Noto Sans uses the SIL Open Font License.
