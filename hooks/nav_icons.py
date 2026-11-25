"""Render leading Material and Simple Icons shortcodes in navigation titles."""

import re

from mkdocs.plugins import event_priority


ICON_TITLE = re.compile(r"^:(material|simple)-([a-z0-9-]+):\s+(.+)$")


def _apply_icons(items):
    for item in items:
        match = ICON_TITLE.match(item.title or "")
        if match:
            library, name, title = match.groups()
            item.title = title
            item.meta = {**getattr(item, "meta", {}), "icon": f"{library}/{name}"}
            if item.is_page:
                item._nav_svg_icon = item.meta["icon"]
        if item.children:
            _apply_icons(item.children)


@event_priority(-100)
def on_nav(nav, **kwargs):
    # Run after awesome-pages has created its sections and links.
    _apply_icons(nav.items)
    return nav


def on_page_markdown(markdown, *, page, **kwargs):
    # Reading a page replaces its metadata after on_nav has run.
    icon = getattr(page, "_nav_svg_icon", None)
    if icon:
        page.meta["icon"] = icon
    return markdown
