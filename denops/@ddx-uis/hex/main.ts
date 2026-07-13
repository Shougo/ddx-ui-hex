import {
  ActionFlags,
  type BaseParams,
  type Context,
  type DdxBuffer,
  type DdxOptions,
  type Encoding,
  type UiOptions,
} from "@shougo/ddx-vim/types";
import { BaseUi, type UiActions } from "@shougo/ddx-vim/ui";
import {
  calculateBinaryDiff,
  numberToUint8Array,
  printError,
  stringToUint8Array,
  uint8ArrayToBase64,
} from "@shougo/ddx-vim/utils";

import type { Denops } from "@denops/std";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";
import { batch } from "@denops/std/batch";
import { crypto } from "@std/crypto";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { isAbsolute } from "@std/path/is-absolute";

// ---------------------------------------------------------------------------
// Module-level precomputed tables (avoid per-call allocations on hot paths)
// ---------------------------------------------------------------------------

/** Two-hex-digit string for every byte value 0x00–0xff. */
const HEX_TABLE: readonly string[] = Array.from(
  { length: 256 },
  (_, i) => i.toString(16).padStart(2, "0"),
);

/**
 * Padding strings for incomplete 16-byte rows.
 * Index = number of missing bytes (0–16); value = " ".repeat(missing * 3).
 */
const PADDING_TABLE: readonly string[] = Array.from(
  { length: 17 },
  (_, missing) => " ".repeat(missing * 3),
);

/** CRC-32 polynomial lookup table (IEEE 802.3). */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

/** Format a Uint8Array as a space-separated lowercase hex string. */
function arrayBufferToHexFast(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += HEX_TABLE[buf[i]];
    if (i !== buf.length - 1) s += " ";
  }
  return s;
}

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
  diffAdd?: string;
  diffChange?: string;
  diffDelete?: string;
  escape?: string;
  ff?: string;
  floating?: string;
  newLine?: string;
  null?: string;
  selected?: string;
  tab?: string;
};

export type SaveParams = {
  path?: string;
  mode?: "base64" | "binary";
};

export type InputType =
  | "hex"
  | "string"
  | "number"
  | "floating";

export type TypeParams = {
  type?: InputType;
  isLittle?: boolean;
  isSigned?: boolean;
  size?: number;
};

export type SearchTypeParams = TypeParams & SearchParams;

export type SearchParams = {
  direction?: "forward" | "backward";
};

export type ChecksumParams = {
  method?: "sum" | "md5" | "sha-1" | "sha-256" | "crc-8" | "crc-16" | "crc-32";
};

export type Params = {
  encoding: Encoding;
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
  #prevSize: number = 0;
  #savedBytes: Uint8Array = Uint8Array.from([]);
  #prevSearchBytes: (number | null)[] | null = null;

  override async redraw(args: {
    denops: Denops;
    context: Context;
    options: DdxOptions;
    buffer: DdxBuffer;
    anotherBuffer: DdxBuffer;
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
    let winid = await fn.bufwinid(args.denops, bufnr);
    const wasWindowClosed = winid < 0;

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
      // Re-fetch winid after the window was freshly opened.
      winid = await fn.bufwinid(args.denops, bufnr);
    }

    await this.#setDefaultParams(args.denops, args.uiParams);

    // NOTE: buffers may be restored
    if (!this.#buffers[args.options.name] || wasWindowClosed) {
      await this.#initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const size = args.buffer.getSize();
    await setStatusline(
      args.denops,
      args.options,
      args.uiParams,
      winid,
      `ddx-ui-hex-${bufnr}`,
      size,
    );

    this.#buffers[args.options.name] = bufnr;

    const prevAddress = await this.#getAddress(args.denops);

    const modified = await fn.getbufvar(args.denops, bufnr, "&modified");
    if (size < this.#prevSize) {
      // Clear previous buffer
      await fn.deletebufline(args.denops, bufnr, 1, "$");
    }
    const length = 16;
    const changedAdresses = args.buffer.getChangedAddresses();

    await renderBufferFast(
      args,
      hasNvim,
      bufnr,
      this.#offset,
      length,
      size,
      1,
      this.#namespace,
      this.#selectedStartAddress,
      changedAdresses,
    );

    if (!Number.isNaN(prevAddress)) {
      await searchAddress(
        args.denops,
        this.#offset,
        prevAddress,
      );
    }

    await fn.setbufvar(args.denops, bufnr, "&modified", modified);

    this.#prevSize = size;
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

    const winIds = await fn.win_findbuf(args.denops, bufnr) as number[];
    for (const winid of winIds) {
      if (winid <= 0) {
        continue;
      }

      if (
        args.uiParams.split == "no" || await fn.winnr(args.denops, "$") == 1
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
      const params = args.actionParams as TypeParams;

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

      const raw = await InputRawString(args.denops, type, "New");
      if (raw === "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(
        type,
        raw,
        args.uiParams.encoding,
        params.isLittle,
        params.isSigned,
        params.size,
      );
      if (bytes === null) {
        await printError(
          args.denops,
          "Invalid value",
        );
        return ActionFlags.Persist;
      }

      const { isRange, rangeStart, rangeLength } = this.#getRange(address);

      if (bytes.length === 1 && bytes[0] !== null) {
        // Replace range by "bytes".
        args.buffer.changeBytes(
          rangeStart,
          new Uint8Array(rangeLength).fill(bytes[0]),
        );
      } else if (isRange && bytes.length !== rangeLength) {
        await printError(
          args.denops,
          `Length mismatch (expected ${rangeLength} bytes in hex).`,
        );
        return ActionFlags.Persist;
      } else {
        args.buffer.changeBytes(rangeStart, bytes);
      }

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      this.#selectedStartAddress = -1;

      return ActionFlags.Redraw;
    },
    checksum: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as ChecksumParams;

      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const { isRange, rangeStart, rangeLength } = this.#getRange(address);
      if (!isRange) {
        await printError(
          args.denops,
          "The address is not selected.",
        );
        return ActionFlags.Persist;
      }

      const bytes = args.buffer.getBytes(rangeStart, rangeLength);

      const methodMap = {
        "md5": "MD5",
        "sha-1": "SHA-1",
        "sha-256": "SHA-256",
      } as const;

      const sum = params.method === "sum"
        ? calculateChecksum(bytes)
        : params.method && params.method in methodMap
        ? await calculateHash(
          bytes,
          methodMap[params.method as keyof typeof methodMap],
        )
        : params.method === "crc-8"
        ? calculateCRC8(bytes)
        : params.method === "crc-16"
        ? calculateCRC16(bytes)
        : params.method === "crc-32"
        ? calculateCRC32(bytes)
        : "Invalid method";

      await args.denops.call(
        "ddx#util#print",
        `Checksum ${params.method}: ${sum}`,
      );

      return ActionFlags.Persist;
    },
    copy: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
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

      const { rangeStart, rangeLength } = this.#getRange(address);

      this.#savedBytes = args.buffer.getBytes(rangeStart, rangeLength);

      this.#selectedStartAddress = -1;

      return ActionFlags.Redraw;
    },
    insert: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as TypeParams;

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

      const raw = await InputRawString(args.denops, type, "New");
      if (raw == "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(
        type,
        raw,
        args.uiParams.encoding,
        params.isLittle,
        params.isSigned,
        params.size,
      );
      if (bytes === null) {
        await printError(
          args.denops,
          "Invalid value",
        );
        return ActionFlags.Persist;
      }

      args.buffer.insert(address, bytes);

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      return ActionFlags.Redraw;
    },
    inspect: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as TypeParams;

      // Get address
      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const { rangeStart, rangeLength } = this.#getRange(address);

      if (params.type === "string") {
        await args.denops.call(
          "ddx#util#print",
          `Chars: "${args.buffer.getChars(rangeStart, rangeLength)}"`,
        );
      } else if (params.type === "number") {
        const number = args.buffer.getInt(
          rangeStart,
          params.size ?? 4,
          params.isLittle ?? true,
          params.isSigned ?? false,
        );

        await args.denops.call(
          "ddx#util#print",
          `Number: "${number}"`,
        );
      } else if (params.type === "floating") {
        const float = args.buffer.getFloat(
          rangeStart,
          params.size ?? 4,
          params.isLittle ?? true,
          params.isSigned ?? false,
        );

        await args.denops.call(
          "ddx#util#print",
          `Float: "${float}"`,
        );
      } else {
        await args.denops.call(
          "ddx#util#print",
          `Bytes: "${args.buffer.getBytes(rangeStart, rangeLength)}"`,
        );
      }

      return ActionFlags.Persist;
    },
    jump: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const input = await args.denops.call(
        "ddx#util#input",
        "Jump to the address: ",
        "0x",
      ) as string;
      if (input === "") {
        return ActionFlags.Persist;
      }

      let address: number;

      if (/^0x[0-9a-fA-F]+$/.test(input)) {
        // Hex
        address = parseInt(input.slice(2), 16);
      } else if (/%$/.test(input)) {
        // Percentage
        const percentage = parseFloat(input.slice(0, -1));
        if (isNaN(percentage) || percentage < 0 || percentage > 100) {
          await printError(
            args.denops,
            "Invalid percentage",
          );
          return ActionFlags.Persist;
        }

        const bufferSize = await args.buffer.getSize();
        address = Math.floor(bufferSize * (percentage / 100));
      } else if (/^[+-]\d+$/.test(input)) {
        // Offset
        const offset = parseInt(input, 10);
        const currentAddress = await this.#getAddress(args.denops);
        if (Number.isNaN(currentAddress)) {
          await printError(
            args.denops,
            "Invalid address",
          );
          return ActionFlags.Persist;
        }
        address = currentAddress + offset;
      } else {
        await printError(
          args.denops,
          "Invalid input",
        );
        return ActionFlags.Persist;
      }

      await args.denops.call(
        "ddx#jump",
        args.options.name,
        address,
      );

      return ActionFlags.Persist;
    },
    nextDiff: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      anotherBuffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
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

      if (args.options.anotherPath.length == 0) {
        await printError(
          args.denops,
          "anotherPath option is required",
        );

        return ActionFlags.Persist;
      }

      const baseAddress = address + 1;
      const size = args.buffer.getSize();
      const allBytes = args.buffer.getBytes(baseAddress, size);
      const allAnotherBytes = args.anotherBuffer.getBytes(baseAddress, size);

      const diff = calculateBinaryDiff(allBytes, allAnotherBytes);
      if (diff.length > 0) {
        await searchAddress(
          args.denops,
          this.#offset,
          baseAddress + diff[0].offset,
        );
      }

      return ActionFlags.Persist;
    },
    nextSearch: async (args: {
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

      if (!this.#prevSearchBytes) {
        return ActionFlags.Persist;
      }

      const direction = params.direction ?? "forward";
      const pos = args.buffer.search(
        direction == "forward" ? address + 1 : address - 1,
        this.#prevSearchBytes,
        direction,
      );
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
    paste: async (args: {
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

      args.buffer.insert(address, this.#savedBytes);

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

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

      const { rangeStart, rangeLength } = this.#getRange(address);
      this.#savedBytes = args.buffer.remove(rangeStart, rangeLength);

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      this.#selectedStartAddress = -1;

      return ActionFlags.Redraw;
    },
    resize: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
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
        "Resize length: ",
        args.buffer.getSize(),
      ) as string;
      if (input === "") {
        return ActionFlags.Persist;
      }

      const length = Number(input);

      if (isNaN(length) || length <= 0) {
        await printError(
          args.denops,
          "Invalid value",
        );
        return ActionFlags.Persist;
      }

      args.buffer.resize(length);

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", true);

      return ActionFlags.Redraw;
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
    save: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as SaveParams;

      const address = await this.#getAddress(args.denops);
      if (Number.isNaN(address)) {
        await printError(
          args.denops,
          "Invalid address",
        );
        return ActionFlags.Persist;
      }

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const path = params.path ?? "";
      const abspath = path.length === 0
        ? args.buffer.getPath()
        : isAbsolute(path)
        ? path
        : resolve(join(await fn.getcwd(args.denops), path));
      const mode = params.mode ?? "binary";
      let bytes = args.buffer.getBytes(0, args.buffer.getSize());
      if (isRange) {
        if (path.length === 0) {
          await printError(
            args.denops,
            "Save file path is required",
          );

          return ActionFlags.Persist;
        }

        const rangeStart = Math.min(address, this.#selectedStartAddress);
        const rangeLength = Math.abs(this.#selectedStartAddress - address) + 1;

        bytes = args.buffer.getBytes(rangeStart, rangeLength);
      }

      args.buffer.stopAllFileWatchers();

      const file = await Deno.open(abspath, { write: true, create: true });

      try {
        if (mode === "base64") {
          const base64 = uint8ArrayToBase64(bytes);
          const encodedBase64 = new TextEncoder().encode(base64);

          await file.write(encodedBase64);
          await file.truncate(base64.length);
        } else {
          await file.write(bytes);
          await file.truncate(bytes.length);
        }
      } finally {
        file.close();

        args.buffer.startFileWatcher(args.buffer.getPath());
      }

      const savedPath = params.path ??
        (isRange ? abspath : args.buffer.getPath());

      await args.denops.call(
        "ddx#util#print",
        `Saved to "${savedPath}"`,
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
      const params = args.actionParams as SearchTypeParams;

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

      const raw = await InputRawString(args.denops, type, "Search");
      if (raw === "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(
        type,
        raw,
        args.uiParams.encoding,
        params.isLittle,
        params.isSigned,
        params.size,
      );
      if (!bytes) {
        return ActionFlags.Persist;
      }

      this.#prevSearchBytes = bytes;

      const direction = params.direction ?? "forward";
      const pos = args.buffer.search(
        direction == "forward" ? address + 1 : address - 1,
        bytes,
        direction,
      );
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
    substitute: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as TypeParams;

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

      const oldRaw = await InputRawString(args.denops, type, "Search");
      if (oldRaw === "") {
        return ActionFlags.Persist;
      }

      const oldBytes = stringToBytes(
        type,
        oldRaw,
        args.uiParams.encoding,
        params.isLittle,
        params.isSigned,
        params.size,
      );
      if (!oldBytes) {
        return ActionFlags.Persist;
      }

      const newRaw = await InputRawString(args.denops, type, "New");
      if (newRaw === "") {
        return ActionFlags.Persist;
      }

      const newBytes = stringToBytes(
        type,
        newRaw,
        args.uiParams.encoding,
        params.isLittle,
        params.isSigned,
        params.size,
      );
      if (!newBytes) {
        return ActionFlags.Persist;
      }

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const rangeStart = isRange
        ? Math.min(address, this.#selectedStartAddress)
        : address;
      const rangeLength = isRange
        ? Math.abs(this.#selectedStartAddress - address) + 1
        : args.buffer.getSize();

      const cnt = args.buffer.substitute(
        rangeStart,
        rangeLength,
        oldBytes,
        newBytes,
      );

      this.#selectedStartAddress = -1;

      if (cnt <= 0) {
        await printError(
          args.denops,
          "Not found",
        );

        return ActionFlags.Persist;
      }

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
    yank: async (args: {
      denops: Denops;
      context: Context;
      options: DdxOptions;
      buffer: DdxBuffer;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as TypeParams;

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

      const { rangeStart, rangeLength } = this.#getRange(address);

      const text = (type === "hex")
        ? arrayBufferToHexFast(args.buffer.getBytes(rangeStart, rangeLength))
        : args.buffer.getChars(rangeStart, rangeLength);

      await fn.setreg(args.denops, '"', text, "v");
      await fn.setreg(
        args.denops,
        await vars.v.get(args.denops, "register"),
        text,
        "v",
      );

      await args.denops.call(
        "ddx#util#print",
        `Yanked "${text}"`,
      );

      this.#selectedStartAddress = -1;

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
        "ddx_ui_encoding",
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
    if (uiParams.winCol == 0 || uiParams.winWidth == 0) {
      const columns = await op.columns.getGlobal(denops);
      if (uiParams.winCol == 0) {
        uiParams.winCol = Math.trunc(columns / 4);
      }
      if (uiParams.winWidth == 0) {
        uiParams.winWidth = Math.trunc(columns / 2);
      }
    }
  }

  async #getAddress(denops: Denops) {
    const [_type, addressString] = await denops.call(
      "ddx#ui#hex#_get_current_address",
    ) as string[];

    return Number(addressString);
  }

  /** Compute the selected range from the current address.
   *  When no range is active, rangeLength defaults to 1 (single byte). */
  #getRange(
    address: number,
  ): { isRange: boolean; rangeStart: number; rangeLength: number } {
    const isRange = this.#selectedStartAddress >= 0 &&
      address !== this.#selectedStartAddress;
    const rangeStart = isRange
      ? Math.min(address, this.#selectedStartAddress)
      : address;
    const rangeLength = isRange
      ? Math.abs(this.#selectedStartAddress - address) + 1
      : 1;
    return { isRange, rangeStart, rangeLength };
  }
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

  const baseAddress = (offset + address).toString(16).padStart(8, "0").slice(
    -8,
  );
  const addressOffset = address & 0x0f;

  const col = addressOffset * 3 + baseAddress.length + 3;

  await fn.cursor(
    denops,
    row,
    col,
  );
}

function formatHexRow(
  address: number,
  bytes: Uint8Array,
  ascii: string = "",
): string {
  const addressString = address.toString(16).padStart(8, "0").slice(-8);

  if (bytes.length === 0) {
    return `${addressString}: `;
  }

  const hex = arrayBufferToHexFast(bytes);
  const padding = PADDING_TABLE[16 - bytes.length];

  return `${addressString}: ${hex}${padding} |   ${ascii}`;
}

function getByteHighlight(
  byte: number,
  rowAddress: number,
  selectedStartAddress: number,
  changedAddresses: Set<number>,
  changedOffsets: Set<number>,
  addedOffsets: Set<number>,
  deletedOffsets: Set<number>,
  highlights: HighlightGroup,
): string {
  if (selectedStartAddress == rowAddress) {
    return highlights.selected ?? "Visual";
  }
  if (changedAddresses.has(rowAddress)) {
    return highlights.changed ?? "ErrorMsg";
  }
  if (addedOffsets.has(rowAddress)) {
    return highlights.diffAdd ?? "DiffAdd";
  }
  if (changedOffsets.has(rowAddress)) {
    return highlights.diffChange ?? "DiffChange";
  }
  if (deletedOffsets.has(rowAddress)) {
    return highlights.diffDelete ?? "DiffDelete";
  }
  if (byte === 0x00) {
    return highlights.null ?? "";
  }
  if (byte === 0x09) {
    return highlights.tab ?? "";
  }
  if (byte === 0x0a) {
    return highlights.newLine ?? "";
  }
  if (0x01 <= byte && byte <= 0x1f) {
    return highlights.null ?? "";
  }
  if (0x20 <= byte && byte <= 0x7f) {
    return highlights.ascii ?? "";
  }
  if (0x80 <= byte && byte <= 0xfe) {
    return highlights.escape ?? "";
  }
  return "";
}

export async function renderBufferFast(
  args: {
    denops: Denops;
    options: DdxOptions;
    buffer: DdxBuffer;
    anotherBuffer: DdxBuffer;
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
  changedAddresses: Set<number>,
) {
  const lines: string[] = [];
  const hlOps: Array<[number, number, number, string]> = [];

  let start = startOffset;
  let lnum = lnumStart;

  const changedOffsets = new Set<number>();
  const addedOffsets = new Set<number>();
  const deletedOffsets = new Set<number>();

  if (args.options.anotherPath.length > 0) {
    const allBytes = args.buffer.getBytes(start, size);
    const allAnotherBytes = args.anotherBuffer.getBytes(start, size);

    const diff = calculateBinaryDiff(allBytes, allAnotherBytes);

    diff.forEach((change) => {
      switch (change.type) {
        case "added":
          addedOffsets.add(change.offset);
          break;
        case "changed":
          changedOffsets.add(change.offset);
          break;
        case "deleted":
          deletedOffsets.add(change.offset);
          break;
      }
    });
  }

  if (size === 0) {
    lines.push(formatHexRow(start, new Uint8Array(), ""));
  }

  while (start < size) {
    const len = Math.min(length, size - start);
    const bytes = args.buffer.getBytes(start, len);
    const ascii = args.buffer.getChars(start, len, args.uiParams.encoding);

    lines.push(formatHexRow(start, bytes, ascii));

    const addressString = start.toString(16).padStart(8, "0").slice(-8);
    const hexStartCol = addressString.length + 2;

    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const rowAddress = start + i;
      const highlight = getByteHighlight(
        byte,
        rowAddress,
        selectedStartAddress,
        changedAddresses,
        changedOffsets,
        addedOffsets,
        deletedOffsets,
        args.uiParams.highlights,
      );

      if (highlight.length > 0) {
        hlOps.push([lnum, hexStartCol + i * 3, 2, highlight]);
      }
    }

    start += length;
    lnum += 1;
  }

  await args.denops.call(
    "ddx#util#clear_highlights",
    bufnr,
    "ddx-byte-highlights",
    namespace,
  );

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
  size: number,
): Promise<void> {
  const statusState = {
    name: options.name,
    offset: options.offset,
    length: options.length,
    size,
  };
  await fn.setwinvar(
    denops,
    winid,
    "ddx_ui_hex_status",
    statusState,
  );

  const header = `[ddx-${options.name}] `;

  const linenr = [
    "printf('%'.(('$'->line())->len()+1).'d/%d 0x%08x/0x%08x',",
    "'.'->line(),",
    "'$'->line(),",
    "ddx#ui#hex#_get_current_address()[1],",
    "'w:ddx_ui_hex_status'->exists() && w:ddx_ui_hex_status.size > 1 ? " +
    "w:ddx_ui_hex_status.offset + w:ddx_ui_hex_status.size - 1 : 0",
    ")",
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

async function InputRawString(
  denops: Denops,
  type: InputType,
  prefix: string,
): Promise<string> {
  const prompt = type === "hex"
    ? " value: 0x"
    : type === "string"
    ? " string: "
    : type === "number"
    ? " number: "
    : " floating: ";

  const input = await denops.call("ddx#util#input", prefix + prompt) as string;

  if (type === "number" || type === "floating") {
    if (Number.isNaN(Number(input))) {
      return "";
    }

    if (type === "number" && !Number.isInteger(Number(input))) {
      return "";
    }

    if (type === "floating" && Number.isInteger(Number(input))) {
      return "";
    }
  }

  return input;
}

function stringToBytes(
  type: InputType,
  raw: string,
  encoding: Encoding,
  isLittle: boolean | undefined,
  isSigned: boolean | undefined,
  size: number | undefined,
): (number | null)[] | null {
  let bytesString = raw;

  if (type === "string") {
    const bytes = stringToUint8Array(
      raw,
      undefined,
      encoding,
    );

    bytesString = Array.from(bytes, (b) => HEX_TABLE[b]).join("");
  } else if (type === "number" || type === "floating") {
    const bytes = numberToUint8Array(
      Number(raw),
      size ?? 4,
      isLittle ?? true,
      isSigned ?? false,
    );

    bytesString = Array.from(bytes, (b) => HEX_TABLE[b]).join("");
  }

  return hexToBytes(bytesString);
}

// Parse hex string with wildcards (e.g. "3838??" -> [0x38, 0x38, null])
function hexToBytes(s: string): (number | null)[] | null {
  const clean = s.replace(/\s+/g, "").toUpperCase(); // Clean and normalize
  if (clean.length === 0 || clean.length % 2 !== 0) return null;

  const out: (number | null)[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byteStr = clean.slice(i, i + 2);
    if (byteStr === "??") {
      out.push(null); // `??` as wildcard
    } else {
      const b = parseInt(byteStr, 16);
      if (Number.isNaN(b) || b < 0 || b > 255) return null; // Invalid byte
      out.push(b); // Valid byte
    }
  }
  return out;
}

function calculateChecksum(data: Uint8Array): number {
  let sum = 0;
  for (const byte of data) {
    sum += byte;
  }
  return sum & 0xff;
}

function calculateCRC32(data: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  crc ^= 0xffffffff;

  return (crc >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function calculateCRC16(data: Uint8Array): string {
  const POLYNOMIAL = 0x1021;
  let crc = 0xffff;

  for (const byte of data) {
    crc ^= byte << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ POLYNOMIAL;
      } else {
        crc <<= 1;
      }
    }
    crc &= 0xffff;
  }

  return crc.toString(16).padStart(4, "0").toUpperCase();
}

function calculateCRC8(data: Uint8Array): string {
  const POLYNOMIAL = 0x07;
  let crc = 0x00;

  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ POLYNOMIAL) : (crc << 1);
    }
    crc &= 0xff;
  }

  return crc.toString(16).padStart(2, "0").toUpperCase();
}

async function calculateHash(
  data: Uint8Array,
  algorithm: "MD5" | "SHA-1" | "SHA-256",
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(algorithm, data);

  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
