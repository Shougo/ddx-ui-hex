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
  printError,
  stringToUint8Array,
} from "@shougo/ddx-vim/utils";

import type { Denops } from "@denops/std";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";
import { batch } from "@denops/std/batch";
import { crypto } from "@std/crypto";

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
};

export type TypeParams = {
  type?: "hex" | "string";
};

export type ChecksumParams = {
  method?: "sum" | "md5";
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

    const prevAddress = await this.#getAddress(args.denops);

    const modified = await fn.getbufvar(args.denops, bufnr, "&modified");
    const size = args.buffer.getSize();
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

      const raw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "New value: 0x" : "New string: ",
      ) as string;
      if (raw === "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(type, raw, args.uiParams.encoding);
      if (bytes === null) {
        await printError(
          args.denops,
          "Invalid value",
        );
        return ActionFlags.Persist;
      }

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const rangeStart = isRange
        ? Math.min(address, this.#selectedStartAddress)
        : address;
      const rangeLength = isRange
        ? Math.abs(this.#selectedStartAddress - address) + 1
        : 1;

      if (bytes.length !== rangeLength) {
        await printError(
          args.denops,
          `Length mismatch (expected ${rangeLength} bytes in hex).`,
        );
        return ActionFlags.Persist;
      }

      args.buffer.changeBytes(rangeStart, bytes);

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

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      if (!isRange) {
        await printError(
          args.denops,
          "The address is not selected.",
        );
        return ActionFlags.Persist;
      }

      const rangeStart = Math.min(address, this.#selectedStartAddress);
      const rangeLength = Math.abs(this.#selectedStartAddress - address) + 1;

      const bytes = args.buffer.getBytes(rangeStart, rangeLength);

      function calculateChecksum(data: number[]): number {
        let sum = 0;
        for (const byte of data) {
          sum += byte;
        }
        return sum & 0xff;
      }

      async function calculateMD5(data: number[]): Promise<string> {
        const byteArray = new Uint8Array(data);

        const hashBuffer = await crypto.subtle.digest("MD5", byteArray);

        return Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }

      const sum = params.method == "sum"
        ? calculateChecksum(Array.from(bytes))
        : await calculateMD5(Array.from(bytes));

      await args.denops.call(
        "ddx#util#print",
        `Checksum: "${sum}"`,
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

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const rangeStart = isRange
        ? Math.min(address, this.#selectedStartAddress)
        : address;
      const rangeLength = isRange
        ? Math.abs(this.#selectedStartAddress - address) + 1
        : 1;

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

      const raw = await args.denops.call(
        "ddx#util#input",
        "New value: ",
      ) as string;
      if (raw == "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(type, raw, args.uiParams.encoding);
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

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const rangeStart = isRange
        ? Math.min(address, this.#selectedStartAddress)
        : address;
      const rangeLength = isRange
        ? Math.abs(this.#selectedStartAddress - address) + 1
        : 1;
      this.#savedBytes = args.buffer.remove(rangeStart, rangeLength);

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
      if (isRange) {
        const rangeStart = Math.min(address, this.#selectedStartAddress);
        const rangeLength = Math.abs(this.#selectedStartAddress - address) + 1;

        if (path.length === 0) {
          await printError(
            args.denops,
            "Save file path is required",
          );

          return ActionFlags.Persist;
        }

        const file = await Deno.open(path, { write: true, create: true });

        await file.write(args.buffer.getBytes(rangeStart, rangeLength));

        file.close();
      } else {
        await args.buffer.write(path);
      }

      await args.denops.call(
        "ddx#util#print",
        `Saved to "${params.path ?? args.buffer.getPath()}"`,
      );

      const bufnr = this.#buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "&modified", false);

      return ActionFlags.Persist;
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
    search: async (args: {
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

      const raw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "Search value: 0x" : "Search string: ",
      ) as string;
      if (raw === "") {
        return ActionFlags.Persist;
      }

      const bytes = stringToBytes(type, raw, args.uiParams.encoding);
      if (!bytes) {
        return ActionFlags.Persist;
      }

      const pos = args.buffer.search(address, bytes);
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

      const oldRaw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "Search value: 0x" : "Search string: ",
      ) as string;
      if (oldRaw === "") {
        return ActionFlags.Persist;
      }

      const oldBytes = stringToBytes(type, oldRaw, args.uiParams.encoding);
      if (!oldBytes) {
        return ActionFlags.Persist;
      }

      const newRaw = await args.denops.call(
        "ddx#util#input",
        type === "hex" ? "New value: 0x" : "New string: ",
      ) as string;
      if (newRaw === "") {
        return ActionFlags.Persist;
      }

      const newBytes = stringToBytes(type, newRaw, args.uiParams.encoding);
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

      const isRange = this.#selectedStartAddress >= 0 &&
        address !== this.#selectedStartAddress;
      const rangeStart = isRange
        ? Math.min(address, this.#selectedStartAddress)
        : address;
      const rangeLength = isRange
        ? Math.abs(this.#selectedStartAddress - address) + 1
        : 1;

      const text = (type === "hex")
        ? args.buffer.getBytes(rangeStart, rangeLength).toString(16)
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
  changedAdresses: Set<number>,
) {
  const lines: string[] = [];

  // [lnum, colStart (0-based), len, hlGroup]
  const hlOps: Array<[number, number, number, string]> = [];

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

  while (start < size) {
    const len = Math.min(length, size - start);
    const bytes = args.buffer.getBytes(start, len);
    const ascii = args.buffer.getChars(start, len, args.uiParams.encoding);

    const addressString = start.toString(16).padStart(8, "0").slice(-8);
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
      } else if (addedOffsets.has(rowAddress)) {
        highlight = args.uiParams.highlights.diffAdd ?? "DiffAdd";
      } else if (changedOffsets.has(rowAddress)) {
        highlight = args.uiParams.highlights.diffChange ?? "DiffChange";
      } else if (deletedOffsets.has(rowAddress)) {
        highlight = args.uiParams.highlights.diffDelete ?? "DiffDelete";
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

  const header = `[ddx-${options.name}]%m `;

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

function stringToBytes(
  type: "string" | "hex",
  raw: string,
  encoding: Encoding,
): Uint8Array | null {
  let bytesString = raw;

  if (type === "string") {
    const bytes = stringToUint8Array(
      raw,
      undefined,
      encoding,
    );

    // Fast hex conversion (lowercase)
    const hexTable = new Array<string>(256);
    for (let i = 0; i < 256; i++) {
      hexTable[i] = i.toString(16).padStart(2, "0");
    }

    bytesString = Array.from(bytes, (b) => hexTable[b]).join("");
  }

  return hexToBytes(bytesString);
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
