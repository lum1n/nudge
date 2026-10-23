import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * The apps a desktop gets when the settings name none: the ones of these that this machine has.
 * LibreOffice runs on its Qt backend, the one whose windows can be read (on GTK 3 it aborts).
 */
export function foundApps(path = process.env.PATH ?? ""): Record<string, string[]> {
  const find = (program: string) =>
    path
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, program))
      .find((file) => existsSync(file));
  const apps: Record<string, string[]> = {};
  const office = find("libreoffice") ?? find("soffice");
  if (office) {
    const program = dirname(realpathSync(office));
    const qt = ["qt6", "kf6", "qt5", "kf5"].find((name) =>
      existsSync(join(program, `libvclplug_${name}lo.so`)),
    );
    const run = [...(qt ? ["env", `SAL_USE_VCLPLUGIN=${qt}`] : []), office];
    apps.writer = [...run, "--writer", "--norestore", "--nologo"];
    apps.calc = [...run, "--calc", "--norestore", "--nologo"];
  }
  const editor = find("gnome-text-editor");
  if (editor) apps.editor = [editor];
  const files = find("dolphin");
  if (files) apps.files = [files];
  return apps;
}
