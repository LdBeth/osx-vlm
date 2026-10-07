% lwfix10.mp -- LWFIX10, Genera's LGP2 fixed-width font, as pen strokes.
%
% Genera downloads LWFIX10 (SYS:FONTS;LGP2;LWFIX10.BFD) to the printer as a
% 300-dpi bitmap.  Its design is close to a monoline drawn with a 3-pixel
% round pen, so it is redrawn here as strokes of that pen, with an
% elliptical pen where the bowls are lighter across their tops and bottoms;
% psvec draws them in place of the bitmap.  `mpost lwfix10.mp` writes lwfix10.pen, the stroke table psvec
% reads: per glyph, "G name width", then per stroke "S penwidth open|closed"
% ("S penwidth penheight open|closed" for an elliptical pen)
% followed by the start point and one "c1 c2 p" Bezier segment per line
% (a dot is a stroke of no segments), then "E".
%
% Units are pixels of the original bitmap (1/300 inch); the origin is on the
% baseline at the left edge of the 22-pixel cell, so a proof overlays the
% bitmap exactly (fonts/proof).  Stroke centrelines sit on pixel centres:
% the 3-pixel stem in columns 3-5 is x = 4.5.
%
% specimen.mp inputs this file with `specimen` true: each glyph is then
% handed to its specimenglyph(name) instead of going into the table.

if unknown specimen: boolean specimen; specimen := false; fi
string penfile; penfile := jobname & ".pen";
string glyphname;
numeric pw; pw := 3;                  % the pen

% The grid every glyph shares.
numeric lx, rx, mx;                   % stems: left, right, middle
lx := 4.5; rx := 17.5; mx := 10.5;
numeric bl, cap, bar;                 % baseline, cap height, H bar
bl := 1.5; cap := 25.5; bar := 13.5;
numeric xh, asc, dsc;                 % x-height, ascender, descender
xh := 18.5; asc := 26.5; dsc := -6.5;
numeric r;                            % corner radius of bowls
r := 4.5;

vardef fmt(expr x) = decimal (round(x * 100) / 100) enddef;
vardef fpair(expr z) = fmt(xpart z) & " " & fmt(ypart z) enddef;

def glyph(expr name) =
  begingroup
  currentpicture := nullpicture; clearxy;
  pickup pencircle scaled pw;
  glyphname := name;
  if not specimen: write "G " & name & " 22" to penfile; fi
enddef;

def endglyph =
  if specimen: specimenglyph(glyphname) else: writeglyph fi;
  endgroup;
enddef;

def writeglyph =
  for c within currentpicture:
    if stroked c: writestroke(pathpart c,
        (xpart urcorner makepath penpart c) - (xpart llcorner makepath penpart c),
        (ypart urcorner makepath penpart c) - (ypart llcorner makepath penpart c));
    else: errmessage("glyph has a fill; draw everything with the pen");
    fi
  endfor
  write "E" to penfile;
enddef;

def writestroke(expr p, w, h) =
  write "S " & fmt(w) & (if abs(h - w) > 0.01: " " & fmt(h) else: "" fi)
    & (if cycle p: " closed" else: " open" fi) to penfile;
  write fpair(point 0 of p) to penfile;
  for i = 0 upto length p - 1:
    write fpair(postcontrol i of p) & " " & fpair(precontrol i + 1 of p)
      & " " & fpair(point i + 1 of p) to penfile;
  endfor
enddef;

% A box with rounded corners of radius rr: the O, the bowls.
vardef rbox(expr l, b, rt, t, rr) =
  (l, b + rr){up} -- (l, t - rr){up} .. {right}(l + rr, t)
  -- (rt - rr, t){right} .. {down}(rt, t - rr)
  -- (rt, b + rr){down} .. {left}(rt - rr, b)
  -- (l + rr, b){left} .. {up}cycle
enddef;

% Straight strokes.  The bitmap's strokes are 3 pixels per row (steep) or
% per column (shallow), so a diagonal is thinner across than a stem: at
% 45 degrees about 2.1 pixels.  line() draws each segment of a polyline
% with the pen that matches its angle, but no thinner than 2.4.
vardef linepen(expr a, b) =
  save t; t := angle(b - a);
  max(2.4, pw * max(abs sind t, abs cosd t))
enddef;
def line(text pts) =
  begingroup save p_, n_; pair p_[]; n_ := 0;
  for q = pts: p_[incr n_] := q; endfor
  for i = 1 upto n_ - 1:
    pickup pencircle scaled linepen(p_[i], p_[i + 1]);
    draw p_[i] -- p_[i + 1];
  endfor
  pickup pencircle scaled pw;
  endgroup
enddef;

% The bitmap's round strokes are 3 pixels across where they run vertically
% but 2 where they run horizontally: bowls, bars and waists are two rows
% deep.  METAFONT's answer is an elliptical pen, 3 wide and 2 high, whose
% width then varies with the direction of the stroke.  Its horizontals
% centre between two pixel rows, on whole y.
def epen = pickup pencircle xscaled pw yscaled 2 enddef;
numeric ebl, exh, ecap;               % its baseline, x-height and cap height
ebl := 1; exh := 19; ecap := 26;

% A dot the size of the bitmap's 4x4 period.
def bigdot(expr z) = pickup pencircle scaled 4; draw z; pickup pencircle scaled pw enddef;

%% Capitals

path ring; ring := rbox(lx, bl, rx, cap, r);   % O; C, G, S, U cut from it

glyph("A");
  z1 = (3.5, bl); z2 = (9.75, cap); z3 = (12.25, cap); z4 = (18.5, bl);
  draw z1 -- z2 -- z3 -- z4;
  z5 = whatever[z1, z2]; z6 = whatever[z4, z3]; y5 = y6 = bar;
  draw z5 -- z6;
endglyph;

glyph("B");
  draw (lx, bl) -- (lx, cap) -- (14, cap){right} .. {down}(18.5, 21.5)
    -- (18.5, 18){down} .. {left}(13.5, bar) -- (lx, bar);
  draw (13.5, bar){right} .. {down}(18.5, 9.5) -- (18.5, 5.5){down}
    .. {left}(14, bl) -- (lx, bl);
endglyph;

glyph("C");
  draw subpath (5.4, 11.6) of ring;
endglyph;

glyph("D");
  draw (lx, bl) -- (lx, cap) -- (13.5, cap){right} .. {down}(18.5, 20.5)
    -- (18.5, 6.5){down} .. {left}(13.5, bl) -- cycle;
endglyph;

glyph("E");
  draw (rx, cap) -- (lx, cap) -- (lx, bl) -- (rx, bl);
  draw (lx, bar) -- (14.5, bar);
endglyph;

glyph("F");
  draw (rx, cap) -- (lx, cap) -- (lx, bl);
  draw (lx, bar) -- (14.5, bar);
endglyph;

glyph("G");
  draw reverse subpath (5, 11.6) of ring -- (rx, 11.5) -- (12.5, 11.5);
endglyph;

glyph("H");
  draw (lx, bl) -- (lx, cap); draw (rx, bl) -- (rx, cap);
  draw (lx, bar) -- (rx, bar);
endglyph;

glyph("I");
  draw (7.5, cap) -- (13.5, cap); draw (7.5, bl) -- (13.5, bl);
  draw (mx, bl) -- (mx, cap);
endglyph;

glyph("J");
  draw (10.5, cap) -- (rx, cap);
  draw (14.5, cap) -- (14.5, 6.5){down} .. {left}(9, bl) .. {up}(3.5, 5);
endglyph;

glyph("K");
  draw (lx, bl) -- (lx, cap);
  line((rx, cap), (lx, 12.5));
  line((6.5, 12.5), (rx, bl));
endglyph;

glyph("L");
  draw (lx, cap) -- (lx, bl) -- (rx, bl);
endglyph;

glyph("M");
  pickup pencircle scaled 2.8;
  draw (lx, bl) -- (lx, cap) -- (11.5, 14) -- (18.5, cap) -- (18.5, bl);
endglyph;

glyph("N");
  pickup pencircle scaled 2.8; draw (lx, bl) -- (lx, cap) -- (rx, bl) -- (rx, cap);
endglyph;

glyph("O");
  draw ring;
endglyph;

glyph("P");
  draw (lx, bl) -- (lx, cap) -- (14, cap){right} .. {down}(18.5, 21)
    -- (18.5, 18){down} .. {left}(14, 13.5) -- (lx, 13.5);
endglyph;

glyph("Q");
  draw ring;
  pickup pencircle scaled 2.7; draw (11.5, 4.5) -- (13.5, -0.5) -- (16.8, -3.8);
endglyph;

glyph("R");
  draw (lx, bl) -- (lx, cap) -- (14, cap){right} .. {down}(18.5, 21.5)
    -- (18.5, 18){down} .. {left}(14.5, bar) -- (lx, bar);
  line((13.5, bar), (18.5, bl));
endglyph;

glyph("S");
  draw reverse subpath (3, 3.6) of ring -- (lx + r, cap){left}
    .. {down}(lx, cap - r) -- (lx, 19){down} .. (6.5, 15.8) .. (10, 14) .. (14, 12.5)
    .. {down}(rx, 8.5) -- (rx, 6){down} .. {left}(13, bl) -- (9, bl){left}
    .. {up}(lx, 4.5);
endglyph;

glyph("T");
  draw (lx, cap) -- (16.5, cap); draw (mx, cap) -- (mx, bl);
endglyph;

glyph("U");
  draw (lx, cap) -- (lx, bl + r){down} .. {right}(lx + r, bl) -- (rx - r, bl)
    {right} .. {up}(rx, bl + r) -- (rx, cap);
endglyph;

glyph("V");
  pickup pencircle scaled 2.9; draw (lx, cap) -- (9.25, bl) -- (12.75, bl) -- (rx, cap);
endglyph;

% A stroke from a to b that thins from width wa to wb: the union of two
% strokes of the thinner pen, apart by the difference at a and meeting at b,
% so its edges are straight.  Its wide end fits inside a round end of wa.
vardef taper(expr a, b, wa, wb) =
  save n; pair n; n := (unitvector(b - a) rotated 90) * ((wa - wb) / 2);
  pickup pencircle scaled wb; draw (a + n) -- b; draw (a - n) -- b
enddef;

% W and w are one stroke down, up, down, up: the arms in the 3-pixel pen,
% the inner diagonals thinning to the 2-pixel apex and centre stem.
glyph("W");
  draw (3.5, cap) -- (5.5, bl); draw (18.5, cap) -- (16.5, bl);
  taper((5.5, bl), (11, 10.5), pw, 2); taper((16.5, bl), (11, 10.5), pw, 2);
  draw (11, 10.5) -- (11, 16);
endglyph;

glyph("X");
  line((3.5, cap), (18.5, bl)); line((18.5, cap), (3.5, bl));
endglyph;

glyph("Y");
  pickup pencircle scaled 2.8;
  draw (3.5, cap) -- (mx, 12) -- (mx, bl); draw (rx, cap) -- (mx, 12);
endglyph;

% Z and z: the diagonal enters each bar part way along, as in the bitmap,
% with a short upright between, so the whole letter is one path.
glyph("Z");
  pickup pencircle scaled 2.75;
  draw (lx, cap) -- (rx, cap) -- (rx, 23) -- (lx, 4) -- (lx, bl) -- (rx, bl);
endglyph;

%% Lowercase

numeric lr; lr := 18.5;                    % the bowls' right side
path oring; oring := rbox(lx, bl, lr, xh, 5);

glyph("a"); epen;
  draw (5.5, 16.5){dir 80} .. {right}(10, exh) -- (13.5, exh){right} .. {down}(lr, 14)
    -- (lr, 3){down} .. {right}(19.5, ebl);
  draw (lr, 11) -- (9.5, 11){left} .. {down}(lx, 6.5) .. {right}(9.5, ebl)
    -- (12, ebl){right} .. {up}(lr, 5.5);
endglyph;

% The bowl of b, d, p and q, on the stem at lx; d and q reflect it.  It
% leaves the stem in one arc.
picture bbowl;
bbowl := image(epen;
  draw (lx, 14.5){up} .. {right}(12, exh) -- (14, exh){right}
    .. {down}(lr, 14.5) -- (lr, 5.5){down} .. {left}(14, ebl) -- (12, ebl){left}
    .. {up}(lx, 5.5));
def mirror = reflectedabout((11, 0), (11, 1)) enddef;

glyph("b");
  draw (lx, asc) -- (lx, bl); addto currentpicture also bbowl;
endglyph;

glyph("c"); epen;
  draw (17.5, 14.5){up} .. {left}(13.5, exh) -- (9.5, exh){left} .. {down}(lx, 14)
    -- (lx, 6){down} .. {right}(9.5, ebl) -- (13.5, ebl){right} .. {up}(17.5, 5);
endglyph;

glyph("d");
  draw (rx, asc) -- (rx, bl); addto currentpicture also bbowl mirror;
endglyph;

glyph("e"); epen;
  draw (lx, 11) -- (lr, 11) -- (lr, 14){up} .. {left}(13.5, exh) -- (9.5, exh){left}
    .. {down}(lx, 14) -- (lx, 6){down} .. {right}(9.5, ebl) -- (13.5, ebl){right}
    .. {up}(17.5, 5);
endglyph;

glyph("f");
  draw (9.5, bl) -- (9.5, 22);
  draw (5.5, xh) -- (15.5, xh);
  epen;
  draw (9.5, 22){up} .. {right}(14, 27) .. {down}(18.5, 24.5);
endglyph;

glyph("g"); epen;
  draw (lr, 13.5){up} .. {dir 135}(15.5, 17) .. {left}(12, 19) -- (10, 19){left} .. {down}(lx, 14)
    -- (lx, 7){down} .. {right}(10, 2) -- (12, 2){right} .. {dir 45}(15.5, 4) .. {up}(lr, 7.5);
  draw (lr, 19) -- (lr, -2){down} .. {left}(13, -7) -- (10, -7){left} .. {dir 135}(5, -5);
endglyph;

% The arch of n, h and u (u turns it over), off the stem at lx; like the
% bowl of b it leaves the stem in one arc.
picture narch;
narch := image(epen;
  draw (lx, 14.5){up} .. {right}(11.5, exh) -- (13.5, exh){right}
    .. {down}(rx, 15) -- (rx, 14);
  pickup pencircle scaled pw; draw (rx, 14) -- (rx, bl));
def turned = rotatedaround((11, 10), 180) enddef;

glyph("h");
  draw (lx, asc) -- (lx, bl); addto currentpicture also narch;
endglyph;

glyph("i");
  draw (6.5, xh) -- (12.5, xh) -- (12.5, bl);
  draw (12.5, 25.2) -- (12.5, 26.2);
endglyph;

glyph("j");
  draw (7.5, xh) -- (13.5, xh) -- (13.5, -2);
  draw (13.5, 25.2) -- (13.5, 26.2);
  epen;
  draw (13.5, -2){down} .. {left}(9.5, -7) -- (8, -7){left} .. {up}(3.5, -5);
endglyph;

glyph("k");
  draw (lx, asc) -- (lx, bl);
  line((16.5, xh), (lx, 7.5));
  line((8.5, 9.5), (17, bl));
endglyph;

glyph("l");
  draw (5.5, asc) -- (11.5, asc) -- (11.5, bl);
endglyph;

glyph("m");
  draw (3.5, xh) -- (3.5, bl);
  epen;
  draw (3.5, 14){up} .. {right}(7.5, exh) .. {down}(10.5, 14);
  draw (10.5, 14){up} .. {right}(14, exh) .. {down}(rx, 14);
  pickup pencircle scaled pw; draw (10.5, 14) -- (10.5, bl); draw (rx, 14) -- (rx, bl);
endglyph;

glyph("n");
  draw (lx, xh) -- (lx, bl); addto currentpicture also narch;
endglyph;

glyph("o"); epen;
  draw rbox(lx, ebl, lr, exh, 5);
endglyph;

glyph("p");
  draw (lx, xh) -- (lx, dsc); addto currentpicture also bbowl;
endglyph;

glyph("q");
  draw (rx, xh) -- (rx, dsc); addto currentpicture also bbowl mirror;
endglyph;

glyph("r");
  draw (6.5, xh) -- (6.5, bl);
  epen;
  draw (6.5, 14.5){up} .. {right}(13.5, exh) .. {down}(18, 16.5);
endglyph;

glyph("s"); epen;
  % The spine is three rows deep, the bowls' ends two.
  draw (17.5, 16){up} .. {left}(13.5, exh) -- (9.5, exh){left} .. {down}(lx, 15)
    -- (lx, 13);
  draw (lr, 7) -- (lr, 6){down} .. {left}(13.5, ebl) -- (9.5, ebl){left} .. {up}(lx, 4);
  pickup pencircle scaled pw;
  draw (lx, 13){down} .. (7.5, 11) .. (13, 10.5) .. (16.5, 9.5) .. {down}(lr, 7);
endglyph;

glyph("t");
  draw (9.5, 24.5) -- (9.5, 6);
  draw (lx, xh) -- (15.5, xh);
  epen;
  draw (9.5, 6){down} .. (11, 2.5) .. {right}(14.5, ebl) .. {up}(18.5, 4.5);
endglyph;

glyph("u");
  draw (rx, xh) -- (rx, bl); addto currentpicture also narch turned;
endglyph;

glyph("v");
  % The arms are steep at the top and flatten into a narrow round foot, one
  % curve each through one point.  Like the inside of W the stroke thins
  % toward the tip, more gently: two copies of a lighter elliptical pen,
  % apart at the top and meeting at the foot.
  pickup pencircle xscaled 2.6 yscaled 1.8;
  for d = -0.2, 0.2:
    path p; p := (3.5 + d, 19){dir -84} .. (7.5 + d / 2, 5) .. {right}(11, ebl);
    draw p & reverse p mirror;
  endfor
endglyph;

glyph("w");
  draw (3.5, xh) -- (5.5, bl); draw (18.5, xh) -- (16.5, bl);
  taper((5.5, bl), (11, 9.5), pw, 2); taper((16.5, bl), (11, 9.5), pw, 2);
  draw (11, 9.5) -- (11, 12.5);
endglyph;

glyph("x");
  line((3.5, xh), (18.5, bl)); line((18.5, xh), (3.5, bl));
endglyph;

glyph("y"); epen;
  draw (3.5, 19) -- (12, 2.5);
  draw (18.5, 19) --- (12.5, 2) ... {left}(7.5, -7) ... (3.5, -5);
endglyph;

glyph("z");
  pickup pencircle scaled 2.9;
  draw (lx, xh) -- (rx, xh) -- (rx, 16) -- (lx, 3) -- (lx, bl) -- (rx, bl);
endglyph;

%% Figures

glyph("zero");
  line((5.5, 8), (16.5, 19));
  epen;
  draw rbox(lx, ebl, rx, ecap, 5);
endglyph;

glyph("one");
  pickup pencircle scaled 2.8; draw (5, 19.5) -- (12.5, cap) -- (12.5, bl);
endglyph;

glyph("two"); epen;
  draw (lx, 22){dir 75} .. {right}(9.5, ecap) -- (12.5, ecap){right} .. {down}(rx, 21)
    -- (rx, 18);
  % One pen from the hook down into the base.
  pickup pencircle scaled pw;
  draw (rx, 18){down} .. (15.2, 13.5) -- (5.6, 8) .. {down}(lx, 5) -- (lx, bl);
  pickup pencircle scaled pw; draw (lx, bl) -- (rx, bl);
endglyph;

glyph("three"); epen;
  draw (lx, 22){dir 75} .. {right}(9.5, 26) -- (12.5, 26){right} .. {down}(rx, 21)
    -- (rx, 19){down} .. {dir 225}(15, 15.5) .. {left}(12, 14) -- (9.5, 14);
  draw (12, 14){right} .. {dir -45}(15.5, 12) .. {down}(rx, 8.5) -- (rx, 6){down}
    .. {left}(12.5, 1) -- (9.5, 1){left} .. {dir 105}(lx, 5);
endglyph;

glyph("four");
  pickup pencircle scaled 2.9;
  draw (14.5, bl) -- (14.5, cap) -- (12.5, cap) -- (3.5, 9) -- (rx, 9);
endglyph;

glyph("five"); epen;
  % One stroke: the bar, the stem, and out of the stem's foot the bowl.
  draw (16, ecap) -- (5.5, ecap) -- (lx, 14.5){dir 70} .. {right}(9.5, 17) -- (12.5, 17){right}
    .. {down}(rx, 12) -- (rx, 6){down} .. {left}(12.5, ebl) -- (9.5, ebl){left}
    .. {dir 105}(lx, 5);
endglyph;

glyph("six"); epen;
  draw (17.5, 22.5){up} .. {left}(12.5, 26) -- (9.5, 26){left} .. (5, 22.5) .. {down}(3.5, 18)
    -- (3.5, 8){down} .. {right}(9.5, 1) -- (12.5, 1){right} .. {up}(rx, 6)
    -- (rx, 11){up} .. {dir 135}(16, 14.5) .. {left}(12.5, 16) -- (10, 16){left}
    .. {down}(3.5, 11.5);
endglyph;

glyph("seven");
  draw (5.5, cap) -- (rx, cap) -- (rx, 23) .. (12.5, 15) .. {down}(9.5, 7) -- (9.5, bl);
endglyph;

glyph("eight"); epen;
  draw (11.5, 15){left} .. (6.5, 16.5) .. {up}(lx, 19) -- (lx, 21){up} .. {right}(9.5, 26)
    -- (13.5, 26){right} .. {down}(18.5, 21) -- (18.5, 19){down} .. (16.5, 16.5) .. {left}cycle;
  draw (11.5, 15){right} .. (16.5, 13) .. {down}(18.5, 10) -- (18.5, 6){down} .. {left}(13.5, 1)
    -- (9.5, 1){left} .. {up}(lx, 6) -- (lx, 10){up} .. (6.5, 13) .. {right}cycle;
endglyph;

glyph("nine"); epen;
  draw (lx, 4){down} .. {right}(9, 1) -- (13, 1){right} .. {up}(18.5, 6)
    -- (18.5, 20.5){up} .. {left}(13, 26) -- (9.5, 26){left}
    .. {down}(lx, 20.5) -- (lx, 15.5){down} .. {right}(9.5, 11) -- (12, 11){right}
    .. {dir 45}(15.5, 13) .. {up}(18.5, 16.5);
endglyph;

%% Punctuation and symbols

glyph("period");
  bigdot((11, 2));
endglyph;

glyph("colon");
  bigdot((11, 2)); bigdot((11, 15));
endglyph;

% The comma and the quotes: a 4-pixel dot and a 3-pixel tail flush with one
% side of it; a second stroke leaves the dot's other side and eases into
% the tail, upright at both ends, so the dot tapers into the tail.
glyph("comma");
  bigdot((11, 2));
  draw (11.5, 1.5) -- (11.5, -2.5){down} .. (8.5, -5.5); draw (10.5, 2){down} .. {down}(11.5, -2.5);
endglyph;

glyph("semicolon");
  bigdot((11, 15)); bigdot((11, 2));
  draw (11.5, 1.5) -- (11.5, -2.5){down} .. (8.5, -5.5); draw (10.5, 2){down} .. {down}(11.5, -2.5);
endglyph;

% The bitmap steps from four pixels to two; drawn as a straight taper: a
% 4-pixel round head, and a 2-pixel pen run from each side of it, tangent,
% down to the foot.
glyph("exclam");
  bigdot((11, 24));
  pickup pencircle scaled 2; draw (10, 24) -- (11, 8); draw (12, 24) -- (11, 8);
  bigdot((11, 2));
endglyph;

glyph("question");
  pickup pencircle scaled 2.85;
  draw (lx, 23){up} .. {right}(9.5, cap) -- (13, cap){right} .. {down}(rx, 21)
    -- (rx, 19.5){down} .. (14, 15.5) .. (11.5, 13) .. {down}(10.5, 11) -- (10.5, 7.5);
  pickup pencircle scaled pw;
  draw (10.5, bl);
endglyph;

glyph("quotedbl");
  line((7.5, cap), (6.5, 19)); line((13.5, cap), (12.5, 19));
endglyph;

glyph("quoteleft");
  bigdot((9.5, 24.5));
  draw (9, 24.5) -- (9, 21){down} .. (12.5, 17.5); draw (10, 24.5){down} .. {down}(9, 21);
endglyph;

glyph("quoteright");
  bigdot((11.5, 24.5));
  draw (12, 24.5) -- (12, 21){down} .. (9, 17.5); draw (11, 24.5){down} .. {down}(12, 21);
endglyph;

glyph("hyphen");
  draw (lx, 9.5) -- (rx, 9.5);
endglyph;

glyph("underscore");
  draw (1.5, -4.5) -- (20.5, -4.5);
endglyph;

glyph("equal");
  draw (lx, 16.5) -- (rx, 16.5); draw (lx, 8.5) -- (rx, 8.5);
endglyph;

glyph("plus");
  draw (2.5, 9.5) -- (18.5, 9.5); draw (10.5, 1.5) -- (10.5, 17.5);
endglyph;

glyph("asterisk");
  draw (11.5, 3.5) -- (11.5, 19.5);
  line((4, 18), (19, 5)); line((4, 5), (19, 18));
endglyph;

glyph("slash");
  line((4, bl), (18, cap));
endglyph;

glyph("backslash");
  line((4, cap), (18, bl));
endglyph;

glyph("bar");
  draw (11.5, -2.5) -- (11.5, 26.5);
endglyph;

% One arc, no straight middle.  The bitmap's parenthesis is a vertical with
% two angled ends, which drawn large shows its turning points; a single arc
% reads as a parenthesis, at the cost of a few edge pixels against the bitmap.
% `...' keeps it free of inflections, so the ends do not flick.
path paren; paren := (17, 27.5){dir 225} ... {down}(9.25, 10.5) ... {dir 315}(17, -6.5);
glyph("parenleft");
  pickup pencircle scaled 2.2; draw paren;
endglyph;

glyph("parenright");
  pickup pencircle scaled 2.2; draw paren reflectedabout((11, 0), (11, 1));
endglyph;

% One stroke each.  The bitmap's stem is 3 pixels and its bars 2; a 2.75
% pen covers both exactly.
glyph("bracketleft");
  pickup pencircle scaled 2.75; draw (17.5, 27) -- (7.5, 27) -- (7.5, -4) -- (17.5, -4);
endglyph;

glyph("bracketright");
  pickup pencircle scaled 2.75; draw (4.5, 27) -- (14.5, 27) -- (14.5, -4) -- (4.5, -4);
endglyph;

% Each brace is one path through its point.
path brace; brace := (15.5, 28.5) -- (13.5, 28.5) -- (9.5, 24) -- (9.5, 15) -- (5, 11.5)
  -- (9.5, 8) -- (9.5, -1) -- (13.5, -5.5) -- (15.5, -5.5);
glyph("braceleft");
  pickup pencircle scaled 2.5; draw brace;
endglyph;
glyph("braceright");
  pickup pencircle scaled 2.5; draw brace reflectedabout((11, 0), (11, 1));
endglyph;
% The arms run two pixels per row and meet in a round tip, two pixels across:
% an arc tangent to both arms, its outside on the bitmap's edge.
path chevron; chevron := (17, 18.5) -- (4.5, 12.25){dir 206.57} .. {down}(3.1, 10)
  .. {dir -26.57}(4.75, 7.875) -- (17.5, 1.5);
glyph("less");
  pickup pencircle scaled 2.2; draw chevron;
endglyph;

glyph("greater");
  pickup pencircle scaled 2.2; draw chevron mirror;
endglyph;

glyph("asciicircum");
  pickup pencircle scaled 2.7; draw (3, 21.5) -- (11, 25.5) -- (19, 21.5);
endglyph;

glyph("asciitilde");
  pickup pencircle scaled 2.5;
  draw (3, 21.5) .. (7, 23.8) .. (10.5, 23) .. (13.5, 21.7) .. (17.5, 23.5);
endglyph;

glyph("at");
  draw (18.5, 21){up} .. {left}(14, cap) -- (9, cap){left} .. {down}(lx, 21) -- (lx, 6){down}
    .. {right}(9, bl) -- (13, bl){right} .. (17.5, 3);
  draw (18.5, 21) -- (18.5, 10.5);
  epen;
  draw (18.5, 18) -- (12, 18){left} .. {down}(9.5, 15) -- (9.5, 11){down} .. {right}(12.5, 8)
    -- (15.5, 8){right} .. {up}(18.5, 11);
endglyph;

glyph("ampersand");
  pickup pencircle scaled 2.5;
  draw (18.5, 11) .. (16.5, 5.5) .. (10, 1) .. (4.7, 6) .. (10.5, 13)
    .. (14.5, 20) .. (10.5, 26) .. (6.8, 21) .. (10.5, 14) .. (19, 1);
endglyph;

glyph("dollar");
  draw reverse subpath (3, 3.6) of ring -- (lx + r, cap){left}
    .. {down}(lx, cap - r) -- (lx, 19){down} .. (6.5, 15.8) .. (10, 14) .. (14, 12.5)
    .. {down}(rx, 8.5) -- (rx, 6){down} .. {left}(13, bl) -- (9, bl){left}
    .. {up}(lx, 4.5);
  pickup pencircle scaled 2; draw (11, -3.5) -- (11, 28.5);
endglyph;

glyph("numbersign");
  line((7.5, cap), (4.5, -3.5)); line((16.5, cap), (13.5, -3.5));
  draw (3.5, 17.5) -- (19.5, 17.5); draw (2.5, 1.5) -- (17.5, 1.5);
endglyph;

glyph("percent");
  pickup pencircle scaled 2.5;
  draw fullcircle xscaled 6.5 yscaled 7 shifted (6.25, 23);
  draw fullcircle xscaled 6 yscaled 6.5 shifted (15, 4);
  % The slash steps one pixel every two rows, on x = 11 + (y - 13)/2.
  pickup pencircle scaled 2.65;
  draw (9.5, 24.5) .. (13.5, 24.9) .. (17.25, 25.5) -- (5, 1);
endglyph;

if specimen: endinput fi
write EOF to penfile;
end.
