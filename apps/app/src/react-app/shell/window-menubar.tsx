import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/app/lib/desktop";

const menus: ("File" | "Edit" | "View" | "Help")[] = ["File", "Edit", "View", "Help"];

// Use the installed native menus, including their roles and accelerators.
export function WindowMenubar() {
  return (
    <nav aria-label="Application menu" className="hidden h-full items-center titlebar-no-drag windows:flex">
      {menus.map((menu) => (
        <Button
          key={menu}
          variant="ghost"
          size="sm"
          className="px-2 text-muted-foreground"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void desktopBridge.__showApplicationMenu(menu, { x: rect.left, y: rect.bottom });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            event.currentTarget.click();
          }}
        >
          {menu}
        </Button>
      ))}
    </nav>
  );
}
