# A small GTK 3 app for the desktop tests: a field, a text area, a combo box, a checkbox, a list,
# tabs, a menu, and a modal dialog before saving. It appends what it saved to the file named as its
# argument, for the tests to check.
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

window = Gtk.Window(title="Notes")
window.set_default_size(640, 480)
outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
window.add(outer)

menubar = Gtk.MenuBar()
file_item = Gtk.MenuItem(label="File")
file_menu = Gtk.Menu()
file_item.set_submenu(file_menu)
clear_item = Gtk.MenuItem(label="Clear")
quit_item = Gtk.MenuItem(label="Quit")
file_menu.append(clear_item)
file_menu.append(quit_item)
menubar.append(file_item)
outer.pack_start(menubar, False, False, 0)

tabs = Gtk.Notebook()
outer.pack_start(tabs, True, True, 0)

editor = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
tabs.append_page(editor, Gtk.Label(label="Write"))

title_row = Gtk.Box(spacing=6)
title_label = Gtk.Label(label="Title")
title = Gtk.Entry()
title_label.set_mnemonic_widget(title)
title_row.pack_start(title_label, False, False, 0)
title_row.pack_start(title, True, True, 0)
editor.pack_start(title_row, False, False, 0)

category_row = Gtk.Box(spacing=6)
category_label = Gtk.Label(label="Category")
category = Gtk.ComboBoxText()
for name in ("Work", "Home", "Travel"):
    category.append_text(name)
category.set_active(0)
category_label.set_mnemonic_widget(category)
category_row.pack_start(category_label, False, False, 0)
category_row.pack_start(category, False, False, 0)
editor.pack_start(category_row, False, False, 0)

body = Gtk.TextView()
body.get_accessible().set_name("Body")
editor.pack_start(body, True, True, 0)

pinned = Gtk.CheckButton(label="Pinned")
editor.pack_start(pinned, False, False, 0)

save = Gtk.Button(label="Save")
editor.pack_start(save, False, False, 0)
status = Gtk.Label(label="Nothing saved yet")
editor.pack_start(status, False, False, 0)

store = Gtk.ListStore(str, str)
for row in (("Groceries", "Home"), ("Standup", "Work"), ("Flights", "Travel")):
    store.append(row)
saved = Gtk.TreeView(model=store)
saved.get_accessible().set_name("Saved notes")
for i, heading in enumerate(("Title", "Category")):
    saved.append_column(Gtk.TreeViewColumn(heading, Gtk.CellRendererText(), text=i))
tabs.append_page(saved, Gtk.Label(label="Saved"))


def text_of_body():
    buffer = body.get_buffer()
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)


def on_save(_button):
    dialog = Gtk.MessageDialog(
        transient_for=window,
        modal=True,
        message_type=Gtk.MessageType.QUESTION,
        buttons=Gtk.ButtonsType.NONE,
        text=f'Save "{title.get_text()}"?',
    )
    dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
    dialog.add_button("Save note", Gtk.ResponseType.OK)
    response = dialog.run()
    dialog.destroy()
    if response != Gtk.ResponseType.OK:
        status.set_text("Not saved")
        return
    name = title.get_text()
    store.append((name, category.get_active_text()))
    status.set_text(f"Saved {name}")
    record = (
        f"saved title={name!r} category={category.get_active_text()!r} "
        f"pinned={pinned.get_active()} body={text_of_body()!r}"
    )
    if len(sys.argv) > 1:
        with open(sys.argv[1], "a", encoding="utf-8") as out:
            out.write(record + "\n")


save.connect("clicked", on_save)
clear_item.connect("activate", lambda _: (title.set_text(""), body.get_buffer().set_text("")))
quit_item.connect("activate", lambda _: Gtk.main_quit())
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
