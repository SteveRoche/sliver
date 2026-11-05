//! Splits a laid-out page into horizontal bands, each rendered as an SVG of
//! its own. A preview page is as tall as its note, so one SVG would make the
//! webview parse and lay out the whole note for any change; with bands it
//! only needs the ones on screen, and an edit only changes the bands it
//! touches.
//!
//! Cuts go only where no content crosses (between lines and blocks), so
//! nothing is ever split. Where they go depends on the content after the
//! cut, not only on the distance from the previous one, so an edit that
//! changes one band's height leaves the cuts (and bands) after it alone.

use std::collections::BTreeMap;
use std::hash::{DefaultHasher, Hash, Hasher};

use typst::foundations::Smart;
use typst::layout::{Abs, Frame, FrameItem, GroupItem, Point, Size};
use typst::model::Destination;
use typst_layout::Page;

/// Bands are at least this tall, unless the page is shorter.
const MIN_HEIGHT: f64 = 400.0;
/// A band is cut at the first gap past this height, whatever follows it.
const MAX_HEIGHT: f64 = 1200.0;
/// Past `MIN_HEIGHT`, roughly one gap in this many is a cut.
const CUT_EVERY: u64 = 4;

/// A band of a page: from `top` (points from the page's top), `height` tall.
pub struct Band {
    pub top: Abs,
    pub height: Abs,
    /// Identifies what the band shows, wherever it is on the page.
    pub key: u64,
    /// The band as a page of its own: its content moved up by `top`, with a
    /// transparent background (the page's fill is drawn once, under every
    /// band).
    pub page: Page,
}

/// The bands of `page`, top to bottom, covering it without gaps.
pub fn bands(page: &Page) -> Vec<Band> {
    let cuts = cuts(&page.frame);
    let mut parts = split(&page.frame, Abs::zero(), &cuts);
    let edges: Vec<Abs> = std::iter::once(Abs::zero())
        .chain(cuts.iter().copied())
        .chain(std::iter::once(page.frame.height()))
        .collect();
    edges
        .windows(2)
        .enumerate()
        .map(|(i, edge)| {
            let (top, height) = (edge[0], edge[1] - edge[0]);
            let size = Size::new(page.frame.width(), height);
            let mut frame = Frame::hard(size);
            if let Some(part) = parts.remove(&i) {
                for (pos, item) in part.items() {
                    frame.push(*pos - Point::with_y(top), item.clone());
                }
            }
            Band {
                top,
                height,
                key: {
                    let mut hasher = DefaultHasher::new();
                    hash_point(size.to_point(), &mut hasher);
                    hash_frame(&frame, &mut hasher);
                    hasher.finish()
                },
                page: Page {
                    frame,
                    bleed: page.bleed,
                    fill: Smart::Custom(None),
                    numbering: None,
                    supplement: page.supplement.clone(),
                    number: page.number,
                },
            }
        })
        .collect()
}

/// `page` with nothing on it but its fill, drawn under its bands.
pub fn background(page: &Page) -> Page {
    Page {
        frame: Frame::hard(page.frame.size()),
        bleed: page.bleed,
        fill: page.fill.clone(),
        numbering: None,
        supplement: page.supplement.clone(),
        number: page.number,
    }
}

/// Groups whose items can go to different bands: plain containers. A
/// transformed or clipped group is kept whole.
fn descendable(group: &GroupItem) -> bool {
    group.transform.is_identity() && group.clip.is_none()
}

/// The vertical extent of a leaf item at `origin`, in page coordinates.
/// Text counts from its font's ascender to its descender, so a glyph that
/// reaches past them (a big operator) may overhang its band slightly; bands
/// don't clip.
fn extent(item: &FrameItem, origin: Point) -> (Abs, Abs) {
    let y = origin.y;
    match item {
        FrameItem::Text(text) => {
            let metrics = text.font.metrics();
            (
                y - metrics.ascender.at(text.size),
                y - metrics.descender.at(text.size),
            )
        }
        FrameItem::Shape(shape, _) => {
            let bbox = shape.bbox(true);
            (y + bbox.min.y, y + bbox.max.y)
        }
        FrameItem::Image(_, size, _) | FrameItem::Link(_, size) => (y, y + size.y),
        FrameItem::Group(group) => {
            let size = group.frame.size();
            let corners = [
                Point::zero(),
                Point::with_x(size.x),
                Point::with_y(size.y),
                size.to_point(),
            ]
            .map(|p| p.transform(group.transform).y);
            let min = corners.iter().copied().fold(Abs::inf(), Abs::min);
            let max = corners.iter().copied().fold(-Abs::inf(), Abs::max);
            (y + min, y + max)
        }
        FrameItem::Tag(_) => (y, y),
    }
}

/// Every leaf item under `frame` (at `origin`) with its vertical extent.
fn leaves<'a>(frame: &'a Frame, origin: Point, out: &mut Vec<(Abs, Abs, &'a FrameItem)>) {
    for (pos, item) in frame.items() {
        let at = origin + *pos;
        match item {
            FrameItem::Group(group) if descendable(group) => leaves(&group.frame, at, out),
            FrameItem::Tag(_) => {}
            _ => {
                let (top, bottom) = extent(item, at);
                out.push((top, bottom, item));
            }
        }
    }
}

/// Where to cut `frame` into bands: points from its top, ascending.
fn cuts(frame: &Frame) -> Vec<Abs> {
    if frame.height().to_pt() <= MIN_HEIGHT {
        return Vec::new();
    }
    let mut leaves_ = Vec::new();
    leaves(frame, Point::zero(), &mut leaves_);
    leaves_.sort_by(|a, b| a.0.to_pt().total_cmp(&b.0.to_pt()));

    let mut cuts = Vec::new();
    let mut start = Abs::zero();
    let mut bottom = -Abs::inf();
    for (top, leaf_bottom, item) in leaves_ {
        if top > bottom && bottom > start {
            let cut = (bottom + top) / 2.0;
            let height = (cut - start).to_pt();
            let end = frame.height().to_pt() - cut.to_pt();
            if height >= MIN_HEIGHT
                && end >= MIN_HEIGHT / 4.0
                && (height >= MAX_HEIGHT || {
                    let mut hasher = DefaultHasher::new();
                    hash_item(item, &mut hasher);
                    hasher.finish().is_multiple_of(CUT_EVERY)
                })
            {
                cuts.push(cut);
                start = cut;
            }
        }
        bottom = bottom.max(leaf_bottom);
    }
    cuts
}

/// `frame`'s items sorted into bands by where they start, keeping the
/// groups they are in (a group spanning several bands is in each, with the
/// items of that band). Keyed by band index.
fn split(frame: &Frame, origin: Abs, cuts: &[Abs]) -> BTreeMap<usize, Frame> {
    let mut parts: BTreeMap<usize, Frame> = BTreeMap::new();
    for (pos, item) in frame.items() {
        let at = Point::new(pos.x, origin + pos.y);
        let mut put = |band: usize, item: FrameItem| {
            parts
                .entry(band)
                .or_insert_with(|| Frame::new(frame.size(), frame.kind()))
                .push(*pos, item);
        };
        match item {
            FrameItem::Group(group) if descendable(group) => {
                for (band, sub) in split(&group.frame, at.y, cuts) {
                    put(
                        band,
                        FrameItem::Group(GroupItem {
                            frame: sub,
                            ..group.clone()
                        }),
                    );
                }
            }
            _ => {
                let (top, _) = extent(item, at);
                put(cuts.partition_point(|cut| *cut <= top), item.clone());
            }
        }
    }
    parts
}

/// Hashes what an SVG of `frame` shows. Typst's own hash also covers source
/// spans and introspection locations, which an edit renumbers in everything
/// after it, although nothing about those bands looks different.
/// A group's size isn't drawn (a split group keeps its whole size), so only
/// the band's own size counts, hashed by the caller.
fn hash_frame(frame: &Frame, state: &mut DefaultHasher) {
    for (pos, item) in frame.items() {
        if !matches!(item, FrameItem::Tag(_)) {
            hash_point(*pos, state);
            hash_item(item, state);
        }
    }
}

/// Rounded: positions relative to a band's top (and its height) pick up
/// float error when the band moves.
fn hash_point(point: Point, state: &mut DefaultHasher) {
    for v in [point.x, point.y] {
        ((v.to_pt() * 1000.0).round() as i64).hash(state);
    }
}

fn hash_item(item: &FrameItem, state: &mut DefaultHasher) {
    std::mem::discriminant(item).hash(state);
    match item {
        FrameItem::Group(group) => {
            group.transform.hash(state);
            group.clip.hash(state);
            hash_frame(&group.frame, state);
        }
        FrameItem::Text(text) => {
            text.font.hash(state);
            text.size.hash(state);
            text.fill.hash(state);
            text.stroke.hash(state);
            text.text.hash(state);
            for glyph in &text.glyphs {
                glyph.id.hash(state);
                glyph.x_advance.hash(state);
                glyph.x_offset.hash(state);
                glyph.y_advance.hash(state);
                glyph.y_offset.hash(state);
            }
        }
        FrameItem::Shape(shape, _) => shape.hash(state),
        FrameItem::Image(image, size, _) => {
            image.hash(state);
            size.hash(state);
        }
        FrameItem::Link(destination, size) => {
            size.hash(state);
            match destination {
                Destination::Url(url) => url.hash(state),
                Destination::Position(position) => position.hash(state),
                // Rendered without a target.
                Destination::Location(_) => {}
            }
        }
        FrameItem::Tag(_) => {}
    }
}
