function ddx#ui#hex#do_action(name, options = {}) abort
  if !'b:ddx_ui_name'->exists() || &filetype !=# 'ddx-hex'
    return
  endif

  call ddx#ui_action(b:ddx_ui_name, a:name, a:options)
endfunction

function ddx#ui#hex#parse_address(string, cur_text, encoding) abort
  " Get last address.
  const base_address = a:string->matchstr('^\x\+')

  " TODO
  const ascii_width = 16

  " Default.
  let type = 'address'
  let address = base_address->str2nr(16)

  if a:cur_text =~# '^\s*\x\+\s*:[[:xdigit:][:space:]]\+\S$'
    " Check hex line.
    let offset = a:cur_text->matchstr(
          \ '^\s*\x\+\s*:\zs[[:xdigit:][:space:]]\+$')->split()->len() - 1
    if 0 <= offset && offset < 16
      let type = 'hex'
      let address += offset
    endif
  elseif a:cur_text =~# '\x\+\s\+|.*$'
    let chars = a:cur_text->matchstr('\x\+\s\+|\zs.*\ze.$')
    let offset = (a:encoding ==# 'latin1') ?
          \ chars->len() - 4 + 1 : chars->strwidth() - 4 + 1
    if offset < 0
      let offset = 0
    endif

    if offset > ascii_width
      let type = 'ascii'
      let address += offset
    endif
  endif

  return [type, address]
endfunction

function ddx#ui#hex#get_cur_text(string, col) abort
  return a:string->matchstr('^.*\%' .. a:col . 'c.')
endfunction

function ddx#ui#hex#_highlight_cursor() abort
  if !'b:ddx_ui_hex_encoding'->exists()
    return
  endif

  const [type, address] = ddx#ui#hex#_get_current_address()
  "echomsg [type, address]

  const highlight_id = 100

  silent! call matchdelete(highlight_id)

  if type ==# 'hex'
    " Highlight ascii area
    const pattern = printf('\%%.l\%%%dv', 63 + address % 16)
    const highlight = b:ddx_ui_hex_highlights->get('cursorAscii', 'Search')
    call matchadd(highlight, pattern, 100, highlight_id)
  endif
endfunction

function ddx#ui#hex#_get_current_address() abort
  const current_line = '.'->getline()
  const cur_text = ddx#ui#hex#get_cur_text(current_line, '.'->col())
  return ddx#ui#hex#parse_address(
        \ current_line, cur_text, b:ddx_ui_hex_encoding)
endfunction
