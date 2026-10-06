# PrintGo-MCP

PrintGo lets an AI assistant print to the printers on your computer. It's an
[MCP](https://modelcontextprotocol.io) server: once your MCP client is
connected to it, the assistant can list your printers, send them PDFs, images,
text, Markdown, or HTML, and check on the jobs afterwards.

PrintGo runs on the computer the printer is connected to and puts itself
behind a Cloudflare tunnel, so your assistant can reach it from anywhere: a
cloud agent, another laptop, or the same machine.

## What you need

- Node.js 22.12 or newer.
- macOS, Linux, or Windows, with a printer your operating system already knows
  about. PrintGo doesn't install drivers; it talks to the print system you
  already have:
  - **macOS and Linux** use CUPS (the `lp`, `lpstat`, `lpoptions`, and `cancel`
    commands).
  - **Windows** uses PowerShell and [SumatraPDF](https://www.sumatrapdfreader.org/).
    PrintGo turns everything into a PDF before printing, so SumatraPDF is
    needed for every job, not just PDFs. It should be on your `PATH`, or you
    can point to it with `--sumatra-pdf <path>`.
- Chrome or Chromium, but only if you want to print Markdown or HTML. If you
  don't have either, `printgo install-browser` will download one. To use a
  specific browser, pass `--chrome <path>` or set `PRINTGO_CHROME_PATH`.

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
prints an MCP URL and a password. Add that URL to your MCP client and send the
password as an `Authorization: Bearer <password>` header. Your client needs
to support MCP's Streamable HTTP transport; the older SSE transport isn't
supported.

The password is generated the first time you run `start` and reused after
that. Treat it like a key to your printer: anyone who has it can print, and
can cancel jobs PrintGo has submitted. Traffic goes through Cloudflare.

PrintGo needs `cloudflared` for the tunnel. If it can't find one, it asks
before downloading the official release from GitHub. Pass `--yes` to skip the
question (you'll need this when there's no terminal to answer it), or
`--no-download` to fail instead. If `cloudflared` lives somewhere unusual,
pass `--cloudflared <path>`.

If you'd rather not install globally, `npx printgo <command>` works too. The
package also installs a `printgo-mcp` command, which is the same thing under
another name.

### Managing the server

```sh
printgo status
printgo stop
printgo restart
```

`restart` reuses the settings from your last `start`. If something goes wrong,
the background server's log is at `~/.printgo/daemon.log`.

By default you get a Cloudflare Quick Tunnel, which needs no Cloudflare
account, but its URL changes every time PrintGo starts. If you have a domain on
Cloudflare, you can give PrintGo a stable address instead:

```sh
printgo stop
printgo start --custom-domain-with-cf printer.example.com
```

If `cloudflared` isn't logged in to your Cloudflare account yet, this opens a
browser so you can log in. PrintGo then creates a tunnel in your account (or
reuses one it made before) and adds a DNS record for that hostname. It won't
overwrite a DNS record that already exists.

Custom domain settings are saved, so later `start` and `restart` calls reuse
them. Pass `--quick` to use a Quick Tunnel for a particular run. You can also
connect a tunnel you already have, or use a token from the Cloudflare
dashboard; `printgo start --help` lists all the options. Add `--json` to
`start`, `stop`, `status`, or `restart` if you're calling them from a script.

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
| `checkPrinterStatus` | Shows a printer's current state, such as idle or printing |
| `sendPrintCommand` | Prints a PDF, PNG, JPEG, or plain text file from an HTTPS URL |
| `printMarkup` | Renders Markdown or HTML and prints it |
| `getPrintJobStatus` | Checks on a job PrintGo submitted |
| `cancelPrintJob` | Cancels a job PrintGo submitted |

When printing, the assistant can choose the number of copies (up to 100), page
ranges, paper size, orientation, single- or double-sided, color or black and
white, and whether to fit the content to the page.

A few things worth knowing:

- **Files come from URLs, not your disk.** The assistant passes a public HTTPS
  link and PrintGo downloads it. Signed links work. Local file paths and
  private network addresses are refused, including through redirects, so a
  prompt can't trick PrintGo into printing something off your machine or your
  local network. Downloads are capped at 10 MiB.
- **Link to the file itself.** `sendPrintCommand` wants a direct download, not a
  web page that displays the file. To print HTML, use `printMarkup`.
- **Markdown and HTML can be passed inline** (up to 32 KiB) or by URL (up to
  1 MiB). PrintGo renders them in headless Chrome with scripts disabled. Images
  and stylesheets they link to must also be public HTTPS URLs.
- **Word, Excel, and other Office files aren't supported.** Convert them to PDF
  first. PrintGo works out whether a URL is text from its file extension or the
  server's content type; if it can't tell, set `assetType: 'text'`.
- **Retries won't print twice.** Every print request carries an
  `idempotencyKey`. If the assistant retries with the same key and arguments,
  PrintGo returns the original job instead of printing again. Reusing a key
  with different arguments is an error. A new key means a new print.
- **Job status only reflects the print queue.** Printers don't report whether
  paper actually came out. On macOS and Linux, `completed` means the job left
  the queue, which also happens when a job fails or is cancelled outside
  PrintGo. On Windows, a job that has left the queue shows as `unknown`.

## Where PrintGo keeps its state

PrintGo keeps everything in `~/.printgo`: the remote password, tunnel settings,
job history, idempotency keys, logs, and any `cloudflared` or Chrome it
downloaded. You can point it somewhere else with `--state-dir`, the
`PRINTGO_HOME` environment variable, or the `stateDir` option in the SDK.

If you run more than one PrintGo server at a time, for example the background
server and a stdio one, give each its own directory so they don't step on each
other's job history.

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

The URL must be HTTPS, except for `localhost` during development.

To talk to a local server over stdio instead, pass
`{ transport: new StdioClientTransport({ command, args }) }`, importing
`StdioClientTransport` from `@modelcontextprotocol/client/stdio`. The client
opens and closes the transport for you.

### Running the server yourself

To serve over stdio from your own process:

```ts
import { servePrinterStdio } from 'printgo';

const server = servePrinterStdio();
// It closes by itself when stdin ends, or you can call: await server.close();
```

If you want more control, there are two lower-level options:

- `createPrinterMcpServer(options?)` returns an MCP server that isn't connected
  to anything yet, so you can attach your own transport.
- `createPrinterHttpServer({ password, ...options })` returns an HTTP server
  with `listen()`, `close()`, and `setPublicURL()`. It serves MCP at `/mcp`,
  only listens on `127.0.0.1`, and requires a password of at least 32
  characters. If you put it behind your own proxy, call `setPublicURL()` with
  the public address; requests for any other hostname are rejected.

Neither one starts a tunnel. Both accept `stateDir`, `adapter`,
`assetDownloader`, `sumatraPdfPath`, and `browserExecutablePath`. If you
supply your own `assetDownloader`, you're taking over PrintGo's URL, size, and
timeout checks, so make sure yours does the same.

### Managing the tunnel from code

The hosting commands live in a separate entry point:

```ts
import { start, stop, status, restart } from 'printgo/hosting';

const connection = await start({ downloadCloudflared: true });
// connection.mcpConnectionURL, connection.password
```

`configureCloudflare` and `ensureCloudflared` are exported from there as well.

## Working on PrintGo

From a clone of this repo:

```sh
npm install
npm test
npm run typecheck
```

`npm test` builds first. The tests use fake printers and a fake `cloudflared`,
so they won't print anything or touch Cloudflare. The Markdown and HTML
rendering tests need a local Chrome or Chromium and are skipped if there isn't
one; set `REQUIRE_CHROMIUM_TESTS=1` to make that a failure instead.

`npm run smoke:tunnel` starts a real Quick Tunnel and checks that an
authenticated MCP client can reach PrintGo through it, without printing
anything. It needs `cloudflared` installed, or run
`npm run smoke:tunnel -- --yes` to let it download one.

Before publishing, `npm pack --dry-run` shows what will go into the package.

## License

MIT. The bundled Noto Sans font is under the SIL Open Font License.
