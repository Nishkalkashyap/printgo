# PrintGo-MCP

PrintGo lets an AI assistant print to the printers on your computer. It's an
[MCP](https://modelcontextprotocol.io) server: you connect it to Claude, Cursor,
or any other MCP client, and the assistant can list your printers, send them
PDFs, images, text, Markdown, or HTML, and check on the jobs afterwards.

PrintGo runs on the computer the printer is connected to and puts itself
behind a Cloudflare tunnel, so your assistant can reach it from anywhere: a
cloud agent, another laptop, or the same machine.

## What you need

- Node.js 22.12 or newer.
- A printer your operating system already knows about. PrintGo doesn't install
  drivers; it talks to whatever print system you already have:
  - **macOS and Linux** use CUPS (the `lp`, `lpstat`, `lpoptions`, and `cancel`
    commands). These are usually already installed.
  - **Windows** uses PowerShell, plus [SumatraPDF](https://www.sumatrapdfreader.org/)
    for printing PDFs.
- Chrome or Chromium, but only if you want to print Markdown or HTML. If you
  don't have either, `printgo install-browser` will download one.

## Getting started

Install the CLI:

```sh
npm install -g printgo
```

Then start it:

```sh
printgo start
```

This starts PrintGo in the background along with a Cloudflare tunnel, then
prints a URL and a password. Add that URL to your MCP client and send the
password as an `Authorization: Bearer <password>` header.

Treat that password like a key to your printer. Anyone who has it can print
and cancel jobs. Traffic goes through Cloudflare.

PrintGo needs `cloudflared` for the tunnel. If it isn't installed, PrintGo will
ask before downloading it. Pass `--yes` to skip the question (useful in
scripts), or `--no-download` to fail instead of downloading.

If you'd rather not install globally, `npx printgo <command>` works too. The
package also installs a `printgo-mcp` command, which is the same thing under
another name.

### Managing the server

```sh
printgo status
printgo stop
printgo restart
```

By default you get a Cloudflare Quick Tunnel, which is free and needs no
account, but its URL changes every time you restart. If you have a domain on
Cloudflare, you can give PrintGo a stable address instead:

```sh
printgo start --custom-domain-with-cf printer.example.com
```

Named tunnel settings are saved, so later `start` and `restart` calls reuse
them. You can also connect an existing tunnel or use a token from the
Cloudflare dashboard; `printgo start --help` lists all the options. Add
`--json` to any of these commands if you're calling them from a script.

### Local only, without a tunnel

If your MCP client runs on the same computer as the printer, you can skip the
tunnel and let the client launch PrintGo directly over stdio:

```json
{
  "mcpServers": {
    "printgo": {
      "command": "printgo",
      "args": ["stdio"]
    }
  }
}
```

You don't run `printgo start` in this mode. The client starts PrintGo when it
needs it and shuts it down when it's done, and there's no password or
Cloudflare involved.

## What the assistant can do

PrintGo gives the assistant seven tools:

| Tool | What it does |
| --- | --- |
| `listPrinters` | Lists the printers set up on your computer |
| `getPrinterCapabilities` | Shows the options a printer's driver supports |
| `checkPrinterStatus` | Shows what's in a printer's queue |
| `sendPrintCommand` | Prints a PDF, PNG, JPEG, or plain text file from an HTTPS URL |
| `printMarkup` | Renders Markdown or HTML and prints it |
| `getPrintJobStatus` | Checks on a job PrintGo submitted |
| `cancelPrintJob` | Cancels a job PrintGo submitted |

When printing, the assistant can choose the number of copies, page ranges,
paper size, orientation, single- or double-sided, color or black and white,
and whether to fit the content to the page.

A few things worth knowing:

- **Files come from URLs, not your disk.** The assistant passes a public HTTPS
  link and PrintGo downloads it. Local file paths and private network addresses
  are refused, so a prompt can't trick it into printing something off your
  machine or your LAN. Downloads are capped at 10 MiB.
- **Markdown and HTML can be passed inline** (up to 32 KiB) or by URL (up to
  1 MiB). PrintGo renders them in a headless browser with JavaScript turned off.
- **Word, Excel, and other Office files aren't supported.** Convert them to PDF
  first. Text files without an extension need `assetType: 'text'`.
- **Retries won't print twice.** Every print request carries an
  `idempotencyKey`. If the assistant retries with the same key and arguments,
  PrintGo returns the original job instead of printing again. A new key means a
  new print.
- **"Completed" means the queue is done with it.** Printers don't report back
  whether paper actually came out, so job status only tells you what the print
  queue knows.

## Where PrintGo keeps its state

PrintGo stores its settings, job history, and idempotency keys in
`~/.printgo`. You can point it somewhere else with `--state-dir`, the
`PRINTGO_HOME` environment variable, or the `stateDir` option in the SDK.

If you run more than one PrintGo server at a time, give each one its own
directory so they don't step on each other's job history.

## Using it as a library

The same package can be used from your own Node code:

```sh
npm install printgo
```

### Talking to a PrintGo server

`connectPrinter` gives you a typed client, so you can call the tools as
ordinary functions:

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

To talk to a local server over stdio instead, pass
`{ transport: new StdioClientTransport({ command, args }) }`, importing
`StdioClientTransport` from `@modelcontextprotocol/client/stdio`. The client
opens and closes the transport for you.

### Running the server yourself

To serve over stdio from your own process:

```ts
import { servePrinterStdio } from 'printgo';

const server = servePrinterStdio();
// later: server.close();
```

If you want more control, there are two lower-level options:

- `createPrinterMcpServer(options?)` returns an MCP server that isn't connected
  to anything yet, so you can attach your own transport.
- `createPrinterHttpServer({ password, ...options })` returns an HTTP server
  with `listen()`, `close()`, and `setPublicURL()`. It only listens on
  localhost and requires a password of at least 32 characters.

Neither one starts a tunnel. Both accept `stateDir`, `adapter`,
`assetDownloader`, `sumatraPdfPath`, and `browserExecutablePath`. If you
supply your own `assetDownloader`, you're taking over PrintGo's URL, size, and
timeout checks, so make sure yours does the same.

### Managing the tunnel from code

The hosting commands live in a separate entry point:

```ts
import { start, stop, status, restart } from 'printgo/hosting';

const connection = await start({ downloadCloudflared: true });
```

`configureCloudflare` and `ensureCloudflared` are exported from there as well.

## Working on PrintGo

From a clone of this repo:

```sh
npm install
npm run build
npm test
npm run typecheck
```

The tests use fake printers and a fake tunnel, so they won't print anything or
touch Cloudflare. The Markdown and HTML rendering tests need a local Chrome or
Chromium and are skipped if there isn't one; set `REQUIRE_CHROMIUM_TESTS=1` to
make that a failure instead. `npm run smoke:tunnel` spins up a real Quick
Tunnel to check the hosting path end to end, still without printing.

Before publishing, `npm pack --dry-run` shows what will go into the package.

## License

MIT. The bundled Noto Sans font is under the SIL Open Font License.
