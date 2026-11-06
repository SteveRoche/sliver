//! An invisible text layer for a rendered page, so text in the preview can
//! be selected and copied: Typst's SVG draws glyphs as outlines, which the
//! webview can't select. Each text run becomes a transparent SVG `<text>`
//! at its baseline, stretched (`textLength`) to the run's width, like
//! PDF.js does for PDFs. The selection highlight is the webview's own, over
//! a stand-in font, so it lines up with the glyphs only approximately.

use std::fmt::Write;

use typst::layout::{Abs, Frame, FrameItem, Transform};
use typst::text::TextItem;

/// Every text run under `frame` with its transform from `frame`'s origin to
/// the run's baseline origin.
pub fn text_items(frame: &Frame) -> Vec<(Transform, &TextItem)> {
    fn walk<'a>(frame: &'a Frame, ts: Transform, out: &mut Vec<(Transform, &'a TextItem)>) {
        for (pos, item) in frame.items() {
            let ts = ts.pre_concat(Transform::translate(pos.x, pos.y));
            match item {
                FrameItem::Group(group) => walk(&group.frame, ts.pre_concat(group.transform), out),
                FrameItem::Text(text) => out.push((ts, text)),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(frame, Transform::identity(), &mut out);
    out
}

/// SVG elements for `frame`'s text, to put on top of its rendering; empty
/// without text. `data-y` is the baseline, for telling lines apart on copy.
pub fn text_layer(frame: &Frame) -> String {
    let mut out = String::new();
    for (ts, text) in text_items(frame) {
        let width: Abs = text.glyphs.iter().map(|g| g.x_advance.at(text.size)).sum();
        if text.text.trim().is_empty() || width <= Abs::zero() {
            continue;
        }
        let _ = write!(
            out,
            "<text transform=\"matrix({} {} {} {} {} {})\" font-size=\"{}\" textLength=\"{}\" \
             lengthAdjust=\"spacingAndGlyphs\" data-y=\"{:.1}\">{}</text>",
            ts.sx.get(),
            ts.ky.get(),
            ts.kx.get(),
            ts.sy.get(),
            ts.tx.to_pt(),
            ts.ty.to_pt(),
            text.size.to_pt(),
            width.to_pt(),
            ts.ty.to_pt(),
            escape(&text.text),
        );
    }
    if out.is_empty() {
        return out;
    }
    format!("<g class=\"text-layer\">{out}</g>")
}

/// `svg` (a whole SVG document) with `frame`'s text layer added on top.
pub fn with_text_layer(mut svg: String, frame: &Frame) -> String {
    let layer = text_layer(frame);
    if let Some(end) = svg.rfind("</svg>") {
        svg.insert_str(end, &layer);
    }
    svg
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            // Typst puts a run's spaces in its text; keep them from collapsing.
            ' ' => out.push('\u{a0}'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}
