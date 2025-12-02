import {
  ActionFlags,
  type BaseParams,
  type Context,
  type DdxBuffer,
  type DdxOptions,
  type UiOptions,
} from "@shougo/ddx-vim/types";
import { BaseUi, type UiActions } from "@shougo/ddx-vim/ui";
import { printError, stringToUint8Array } from "@shougo/ddx-vim/utils";

import type { Denops } from "@denops/std";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";
import { batch } from "@denops/std/batch";

export type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

export type HighlightGroup = {
  ascii?: string;
  changed?: string;
  control?: string;
  cursorAscii?: string;
  escape?: string;
  ff?: string;
  floating?: string;
  newLine?: string;
  null?: string;
  selected?: string;
  tab?: string;
};

export type ChangeParams = {
  type?: "hex" | "string";
};

export type SaveParams = {
  path?: string;
};

export type SearchParams = {
  type?: "hex" | "string";
};

export type Params = {
  encoding: "utf-8";
  floatingBorder: FloatingBorder;
  highlights: HighlightGroup;
  overwriteStatusline: boolean;
  overwriteTitle: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

export class Ui extends BaseUi<Params> {
  #buffers: Record<string, number> = {};
  #namespace: number = 0;
  #offset: number = 0;
  #selectedStartAddress: number = -1;

  override async redraw(args: {
    denops: Denops;
    context: Context;
    options: DdxOptions;
    buffer: DdxBuffer;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    this.#offset = args.buffer.getOffset();

    const bufferName = `ddx-ff-${args.options.name}`;
    const initialized = this.#buffers[args.options.name] ||
      (await fn.bufexists(args.denops, bufferName) &&
        await fn.bufnr(args.denops, bufferName));
    const bufnr = initialized ||
      await this.#initBuffer(args.denops, bufferName);
    const winid = await fn.bufwinid(args.denops, bufnr);

    const hasNvim = args.denops.meta.host == "nvim";
    const floating = args.uiParams.split == "floating" && hasNvim;
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +resize\\ ${Number(args.uiParams.winHeight)} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": Number(args.uiParams.winHeight),
          "border": args.uiParams.floatingBorder,
        });

        await fn.setwinvar(
          args.denops,
          await fn.bufwinnr(args.denops, bufnr),
          "&winhighlight",
          `Normal:${args.uiParams.highlights?.floating ?? "NormalFloat"}`,
        );
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await printError(
          args.denops,
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    }

    await this.#setDefaultParams(args.denops, args.uiParams);

    // NOTE: buffers may be restored
    if (!this.#buffers[args.options.name] || winid < 0) {
      await this.#initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    await setStatusline(
      args.denops,
      args.options,
      args.uiParams,
      await fn.bufwinid(args.denops, bufnr),
      `ddx-ui-hex-${bufnr}`,
    );

    this.#buffers[args.options.name] = bufnr;

    const modified = await fn.getbufvar(args.denops, bufnr, "&modified");
    const size = args.buffer.getSize();
    const length = 16;
    const changedAdresses = args.buffer.getChangedAddresses();

    await renderBufferFast(
      args,
      hasNvim,
      bufnr,
      0,
      length,
      size,
      1,
      this.#namespace,
      this.#selectedStartAddress,
      changedAdresses,
    );

    await fn.setbufvar(args.denops, bufnr, "&modified", modified);
  }

  override async jump(args: {
    denops: Denops;
    context: Context;
    options: DdxOptions;
    uiParams: Params;
    address: number;
  }): Promise<void> {
    // Move to the UI window.
    const bufnr = this.#buffers[args.options.name];
    if (!bufnr) {
      return;
    }

    await fn.win_gotoid(
      args.denops,
      await fn.bufwinid(args.denops, bufnr),
    );

    await searchAddress(args.denops, this.#offset, args.address);
  }

  override async quit(args: {
    denops: Denops;
    context: Context;
    options: DdxOptions;
    uiParams: Params;
  }): Promise<void> {
    // Move to the UI window.
    const bufnr = this.#buffers[args.options.name];
    if (!bufnr) {
      return;
    }

    await fn.win_gotoid(
      args.denops,
      await fn.bufwinid(args.denops, bufnr),
    );

    const prevWinnr = await fn.winnr(args.denops, "#");

    for (
      const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
    ) {
      if (winid <= 0) {
        continue;
      }

      if (
        args.uiParams.split == "no" ||
        !(prevWinnr > 0 && prevWinnr !== await fn.winnr(args.denops))
      ) {
        await fn.setwinvar(args.denops, winid, "&winfixbuf", false);

        await args.denops.cmd(
          args.context.bufNr == this.#buffers[args.options.name] ||
            args.context.bufNr <= 0
            ? "enew!"
            : `buffer! ${args.context.bufNr}`,
        );
      } else {
        await args.denops.cmd("silent! close!");
        await fn.win_gotoid(args.denops, args.context.winId);
      }
    }
  }

  override actions: UiActions<Params> = {
    change: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as ChangeParams;

      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const type = params.type ?? "hex";

      const raw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "New value: 0x" : "New string: ",
      ) as string;
      if (raw === "") {
        return ActionFlags.Persist;
      }

      let bytesString = raw;

      if (type === "string") {
        // Convert to hex string
        const encoder = new TextEncoder();
        bytesString = Array.from(encoder.encode(raw))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      if (isRange) {
        const rangeLength = Math.abs(this.#selectedStartAddress - address) + 1;
        const rangeStart = Math.min(address, this.#selectedStartAddress);

        const bytes = hexToBytes(bytesString);
        if (bytes === null || bytes.length !== rangeLength) {
          await printError(
            args.denops,
            `Invalid value or length mismatch (expected ${rangeLength} bytes in hex).`,
          );
          return ActionFlags.Persist;
        }

        // Apply the bytes starting at `start`
        args.buffer.changeBytes(rangeStart, bytes);
      } else {
        const value = parseStrictInt(bytesString, 16);
        if (Number.isNaN(value) || value > 255 || value < 0) {
          await printError(
            args.denops,
            "Invalid value",
          );
          return ActionFlags.Persist;
        }

        args.buffer.change(address, value);
      }

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      this.#selectedStartAddress = -1;

      return ActionFlags.Redraw;
    },
    insert: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
    }) => {
      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const input = await args.denops.call(
        "ddx#util#input",
        "New value: ",
      ) as string;
      if (input == "") {
        return ActionFlags.Persist;
      }

      const value = parseStrictInt(input, 16);
      if (Number.isNaN(value) || value > 255 || value < 0) {
        await printError(
          args.denops,
          "Invalid value",
        );
        return ActionFlags.Persist;
      }

      const insertValue = new Uint8Array([value]);

      args.buffer.insert(address, insertValue);

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      return ActionFlags.Redraw;
    },
    remove: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
    }) => {
      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      if (
        this.#selectedStartAddress > 0 && address !== this.#selectedStartAddress
      ) {
        const start = Math.min(address, this.#selectedStartAddress);
        const length = Math.abs(this.#selectedStartAddress - address);
        if (length > 0) {
          args.buffer.remove(start, length);
        }
      } else {
        args.buffer.remove(address);
      }

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      this.#selectedStartAddress = -1;

      return ActionFlags.Redraw;
    },
    save: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as SaveParams;

      await args.buffer.write(params.path ?? "");

      await args.denops.call(
        "ddx#util#print",
        `Saved to "${params.path ?? args.buffer.getPath()}"`,
      );

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", false);

      return ActionFlags.Persist;
    },
    search: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as SearchParams;

      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const type = params.type ?? "hex";

      const raw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "Search value: 0x" : "Search string: ",
      ) as string;
      if (raw === "") {
        return ActionFlags.Persist;
      }

      let bytesString = raw;

      if (type === "string") {
        const bytes = stringToUint8Array(
          raw,
          undefined,
          args.uiParams.encoding,
        );

        // Fast hex conversion (lowercase)
        const hexTable = new Array<string>(256);
        for (let i = 0; i < 256; i++) {
          hexTable[i] = i.toString(16).padStart(2, "0");
        }

        bytesString = Array.from(bytes, (b) => hexTable[b]).join("");
      }

      const pos = args.buffer.search(address, hexToBytes(bytesString));

      if (pos >= 0) {
        await searchAddress(args.denops, this.#offset, pos);
      } else {
        await printError(
          args.denops,
          "Not found",
        );
      }

      return ActionFlags.Persist;
    },
    selectAddress: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
    }) => {
      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      if (
        this.#selectedStartAddress >= 0 && address == this.#selectedStartAddress
      ) {
        this.#selectedStartAddress = -1;
      } else {
        this.#selectedStartAddress = address;
      }

      return ActionFlags.Redraw;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });

      return ActionFlags.None;
    },
    redo: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
    }) => {
      args.buffer.redo();

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(
        args.denops,
        bufnr,
        "&modified",
        true,
      );

      return ActionFlags.Redraw;
    },
    undo: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
    }) => {
      const historyLength = args.buffer.undo();

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(
        args.denops,
        bufnr,
        "&modified",
        historyLength > 0,
      );

      return ActionFlags.Redraw;
    },
  };

  override params(): Params {
    return {
      encoding: "utf-8",
      floatingBorder: "none",
      highlights: {},
      overwriteStatusline: true,
      overwriteTitle: false,
      split: "horizontal",
      splitDirection: "botright",
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  async #initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);

    if (denops.meta.host === "nvim") {
      this.#namespace = await denops.call(
        "nvim_create_namespace",
        "ddx-ui-hex",
      ) as number;
    }

    // Init autocmds
    const augroupName = `ddx-ui-hex-${bufnr}`;
    await denops.cmd(`augroup ${augroupName}`);
    await denops.cmd(`autocmd! ${augroupName}`);
    await denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer=${bufnr}>` +
        " call ddx#ui#hex#_highlight_cursor()",
    );

    return bufnr;
  }

  async #initOptions(
    denops: Denops,
    options: DdxOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);
    const existsWinFixBuf = await fn.exists(denops, "+winfixbuf");

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddx_ui_name", options.name);
      await fn.setbufvar(
        denops,
        bufnr,
        "ddx_ui_hex_encoding",
        uiParams.encoding,
      );
      await fn.setbufvar(
        denops,
        bufnr,
        "ddx_ui_hex_highlights",
        uiParams.highlights,
      );

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&cursorline", 1);
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      if (existsWinFixBuf && uiParams.split !== "no") {
        await fn.setwinvar(denops, winid, "&winfixbuf", true);
      }

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "acwrite");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddx-hex");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);
      await fn.setbufvar(denops, bufnr, "&modified", false);

      if (uiParams.split == "horizontal") {
        await fn.setbufvar(denops, bufnr, "&winfixheight", 1);
      } else if (uiParams.split == "vertical") {
        await fn.setbufvar(denops, bufnr, "&winfixwidth", 1);
      }

      if (uiParams.split === "floating") {
        await fn.setwinvar(denops, winid, "&statusline", "");
      }
    });
  }

  async #setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  async #getAddress(denops: Denops) {
    const [_type, addressString] = await denops.call(
      "ddx#ui#hex#_get_current_address",
    ) as string[];

    return Number(addressString);
  }
}

function parseStrictInt(str: string, radix: number = 10): number {
  if (typeof str !== "string" || str.trim() === "") {
    return NaN;
  }

  let pattern: RegExp;
  switch (radix) {
    case 2:
      pattern = /^-?[01]+$/;
      break;
    case 8:
      pattern = /^-?[0-7]+$/;
      break;
    case 10:
      pattern = /^-?\d+$/;
      break;
    case 16:
      pattern = /^-?[0-9a-fA-F]+$/;
      break;
    default:
      return NaN;
  }

  if (!pattern.test(str.trim())) {
    return NaN;
  }
  const n = parseInt(str, radix);
  return Number.isNaN(n) ? NaN : n;
}

async function searchAddress(
  denops: Denops,
  offset: number,
  address: number,
) {
  // Parse address number.
  const row = Math.floor((address - offset) / 0x10) + 1;
  if (row < 0) {
    return;
  }

  await fn.cursor(denops, 1, 1);

  const baseAddress = ("00000000" + address.toString()).slice(-8);
  const addressOffset = address & 0x0f;

  const col = addressOffset * 3 + baseAddress.length + 3;

  await fn.cursor(
    denops,
    row,
    col,
  );
}

// Parse hex string (e.g. "383838" -> [0x38, 0x38, 0x38])
function hexToBytes(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteStr = clean.slice(i * 2, i * 2 + 2);
    const b = parseInt(byteStr, 16);
    if (Number.isNaN(b) || b < 0 || b > 255) return null;
    out[i] = b;
  }
  return out;
}

export async function renderBufferFast(
  args: {
    denops: Denops;
    buffer: DdxBuffer;
    uiParams: Params;
  },
  hasNvim: boolean,
  bufnr: number,
  startOffset: number,
  length: number,
  size: number,
  lnumStart: number,
  namespace: number,
  selectedStartAddress: number,
  changedAdresses: Set<number>,
) {
  const lines: string[] = [];
  const hlOps: Array<[number, number, number, string]> = []; // [lnum, colStart (0-based), len, hlGroup]
  let start = startOffset;
  let lnum = lnumStart; // 1-based line number in vim

  // NOTE: small fast helpers
  const hexTable = new Array(256);
  for (let i = 0; i < 256; i++) {
    hexTable[i] = i.toString(16).padStart(2, "0");
  }
  const arrayBufferToHexFast = (buf: Uint8Array) => {
    let s = "";
    for (let i = 0; i < buf.length; i++) {
      s += hexTable[buf[i]];
      if (i !== buf.length - 1) s += " ";
    }
    return s;
  };

  while (start < size) {
    const bytes = args.buffer.getBytes(
      start,
      Math.min(length, size - start),
    );
    const ascii = args.buffer.getChars(
      start,
      Math.min(length, size - start),
      args.uiParams.encoding,
    );

    const addressString = ("00000000" + start.toString(16)).slice(-8);
    const hex = arrayBufferToHexFast(bytes);
    const padding = " ".repeat((16 - bytes.length) * 3);

    lines.push(`${addressString}: ${hex}${padding} |   ${ascii}`);

    // collect highlight ops for this line (no RPC here)
    // column where bytes hex begin:
    // addressString.length + 2 (": ") = 8 + 2 = 10 (0-based col used later)
    const hexStartCol = addressString.length + 2;
    // But in original code they used addressString.length + 3 * row; adapt to
    // 0-based col start for each byte hex (two hex digits + space)
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      let highlight = "";
      const rowAddress = start + i;
      if (selectedStartAddress == rowAddress) {
        highlight = args.uiParams.highlights.selected ?? "Visual";
      } else if (changedAdresses.has(rowAddress)) {
        highlight = args.uiParams.highlights.changed ?? "ErrorMsg";
      } else if (byte === 0x00) {
        highlight = args.uiParams.highlights.null ?? "";
      } else if (byte === 0x09) {
        highlight = args.uiParams.highlights.tab ?? "";
      } else if (byte === 0x0a) {
        highlight = args.uiParams.highlights.newLine ?? "";
      } else if (0x01 <= byte && byte <= 0x1f) {
        highlight = args.uiParams.highlights.null ?? "";
      } else if (0x20 <= byte && byte <= 0x7f) {
        highlight = args.uiParams.highlights.ascii ?? "";
      } else if (0x80 <= byte && byte <= 0xfe) {
        highlight = args.uiParams.highlights.escape ?? "";
      }

      if (highlight && highlight.length > 0) {
        // calculate column: hexStartCol + i*3 (two hex digits + space)
        const colStart = hexStartCol + i * 3;
        // highlight two columns (hex digits)
        hlOps.push([lnum, colStart, 2, highlight]);
      }
    }

    start += length;
    lnum += 1;
  }

  const startIdx0 = lnumStart - 1;
  const endIdx0 = startIdx0 + lines.length;
  await setBufLines(
    args.denops,
    hasNvim,
    bufnr,
    startIdx0,
    endIdx0,
    lnumStart,
    lines,
  );

  await args.denops.call(
    "ddx#util#apply_highlights",
    bufnr,
    "ddx-byte-highlights",
    hlOps,
    namespace,
  );
}

export async function setBufLines(
  denops: Denops,
  hasNvim: boolean,
  bufnr: number,
  startIdx0: number, // 0-based start (same as nvim_buf_set_lines)
  endIdx0: number, // 0-based end (exclusive) (same as nvim_buf_set_lines)
  lnumStart: number, // 1-based start line for Vim's setbufline
  lines: string[],
) {
  if (hasNvim) {
    // Neovim: use nvim_buf_set_lines (startIdx0/endIdx0 are 0-based)
    await denops.call(
      "nvim_buf_set_lines",
      bufnr,
      startIdx0,
      endIdx0,
      false,
      lines,
    );
    return;
  }

  // Vim: use setbufline which expects 1-based lnum.
  // setbufline(bufnr, lnum, lines) will replace lines starting at lnum with
  // the provided list. If the provided list is shorter than the original
  // range, remove the remainder.
  await fn.setbufline(denops, bufnr, lnumStart, lines);

  // Remove leftover lines if the original replaced-range was longer than
  // lines.length
  const originalCount = endIdx0 - startIdx0;
  if (lines.length < originalCount) {
    const deleteStart = lnumStart + lines.length;
    const deleteEnd = lnumStart + originalCount - 1;
    // deletebufline(bufnr, start, end) deletes inclusive range of lines
    // (1-based)
    await fn.deletebufline(denops, bufnr, deleteStart, deleteEnd);
  }
}

async function setStatusline(
  denops: Denops,
  options: DdxOptions,
  uiParams: Params,
  winid: number,
  augroupName: string,
): Promise<void> {
  const statusState = {
    name: options.name,
  };
  await fn.setwinvar(
    denops,
    winid,
    "ddx_ui_hex_status",
    statusState,
  );

  const header = `[ddx-${options.name}]`;

  const linenr = [
    "printf('%'.(('$'->line())->len()+2).'d/%d 0x%08x',",
    "'.'->line(),",
    "'$'->line(), ",
    "ddx#ui#hex#_get_current_address()[1])",
  ].join("");
  const laststatus = await op.laststatus.getGlobal(denops);

  const footer = "";

  if (laststatus === 0 || uiParams.overwriteTitle) {
    if (await vars.g.get(denops, "ddx#ui#hex#_save_title", "") === "") {
      await vars.g.set(
        denops,
        "ddx#ui#hex#_save_title",
        await op.titlestring.getGlobal(denops),
      );
    }

    await denops.cmd(
      `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
        " let &titlestring=g:ddx#ui#hex#_save_title",
    );

    const titleString = `${header} %{${linenr}}%*${footer}`;
    await vars.b.set(denops, "ddx_ui_hex_title", titleString);
    await op.titlestring.setGlobal(denops, titleString);

    await denops.cmd(
      `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
        " let &titlestring=b:->get('ddx_ui_hex_title', '')",
    );
  } else if (uiParams.overwriteStatusline) {
    await fn.setwinvar(
      denops,
      winid,
      "&statusline",
      `${header.replaceAll("%", "%%")} %#LineNR#%{${linenr}}%*${footer}`,
    );
  }
}
