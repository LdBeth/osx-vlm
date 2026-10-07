% specimen.mp -- a specimen sheet of LWFIX10 as drawn in lwfix10.mp.
%
%   mpost specimen.mp      writes specimen.png
%
% Every glyph in the order lwfix10.mp draws it, in its 22-pixel cell (grey
% box, baseline in grey), above its PostScript glyph name.

boolean specimen; specimen := true;
outputformat := "png"; outputtemplate := "%j.png";
hppp := vppp := 1/6;                  % 6 output pixels per bitmap pixel

numeric cols, cellw, cellh, nglyphs;
cols := 10; cellw := 32; cellh := 54; nglyphs := 0;
picture sheet; sheet := nullpicture;
color guide; guide := 0.8white;

% Text centred on (x, y) at its baseline; words joined with real gaps, as
% cmtt10 prints its space as a visible-space mark.
vardef caption(expr x, y, sz)(text words) =
  save p, q, w; picture p, q; numeric w; p := nullpicture; w := 0;
  for s_ = words:
    q := s_ infont "cmtt10" scaled sz;
    addto p also q shifted (w, 0);
    w := w + xpart urcorner q + 0.6 * sz * 10;
  endfor
  w := w - 0.6 * sz * 10;
  p shifted (x - w / 2, y)
enddef;

def specimenglyph(expr name) =
  begingroup save o; pair o;
  o := (cellw * (nglyphs mod cols), -cellh * (nglyphs div cols));
  addto sheet doublepath ((0, -9) -- (22, -9) -- (22, 30) -- (0, 30) -- cycle)
    shifted o withpen pencircle scaled 0.25 withcolor guide;
  addto sheet doublepath ((0, 0) -- (22, 0)) shifted o
    withpen pencircle scaled 0.25 withcolor guide;
  addto sheet also currentpicture shifted o;
  addto sheet also caption(xpart o + 11, ypart o - 14, 0.45)(name);
  nglyphs := nglyphs + 1;
  endgroup
enddef;

input lwfix10

beginfig(1);
  draw sheet;
  draw caption(cols * cellw / 2 - 5, 34, 0.9)
    ("LWFIX10:", decimal nglyphs, "glyphs", "as", "drawn", "in", "lwfix10.mp");
  draw bbox currentpicture withcolor white;   % margin
endfig;
end.
