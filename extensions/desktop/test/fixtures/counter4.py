# A small GTK 4 app for the desktop tests: a button in the header bar, which GTK 4 places by window
# coordinates that start at the shadow, and a menu button whose popover menu labels its items
# with nameless text objects.
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, Gtk  # noqa: E402

app = Gtk.Application(application_id="dev.nudge.Counter4")


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="Counter")
    window.set_default_size(480, 320)
    header = Gtk.HeaderBar()
    window.set_titlebar(header)

    count = Gtk.Label(label="Clicks: 0")
    window.set_child(count)
    clicks = [0]

    def show():
        count.set_label(f"Clicks: {clicks[0]}")

    def add(_button):
        clicks[0] += 1
        show()

    add_button = Gtk.Button(label="Add")
    add_button.connect("clicked", add)
    header.pack_end(add_button)

    def reset(_action, _parameter):
        clicks[0] = 0
        show()

    action = Gio.SimpleAction(name="reset")
    action.connect("activate", reset)
    window.add_action(action)
    menu = Gio.Menu()
    menu.append("Reset count", "win.reset")
    menu.append("Do nothing", "win.nothing")
    menu_button = Gtk.MenuButton(menu_model=menu, icon_name="open-menu-symbolic")
    menu_button.set_tooltip_text("Main Menu")
    menu_button.update_property([Gtk.AccessibleProperty.LABEL], ["Main Menu"])
    header.pack_start(menu_button)
    window.present()


app.connect("activate", activate)
app.run(None)
