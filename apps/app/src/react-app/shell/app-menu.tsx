import {mailNotificationOpenSchema} from '../../../../server/src/mail/notification-view';
/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useUpdateCheckRequestStore } from "../domains/settings/state/update-check-request";
import { useUiStateStore } from "./ui-state-store";

const NATIVE_MENU_OPEN_SETTINGS_EVENT = "legalwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "legalwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "legalwork:native-menu:check-updates";

export function AppMenuProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);

  useEffect(() => {
    let active=true;const openMail=()=>{void window.__LEGALWORK_ELECTRON__?.mailNotificationTarget?.().then(value=>{const target=mailNotificationOpenSchema.safeParse(value);if(active&&target.success)navigate('/mail',{state:{mailNotificationTarget:target.data}});}).catch(()=>{});};
    window.addEventListener('legalwork-mail-notification-open',openMail);openMail();
    const openSettings = () => navigate("/settings/general");
    const checkUpdates = () => {
      useUpdateCheckRequestStore.getState().requestUpdateCheck();
      navigate("/settings/updates");
    };

    window.addEventListener(NATIVE_MENU_OPEN_SETTINGS_EVENT, openSettings);
    window.addEventListener(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, toggleSidebar);
    window.addEventListener(NATIVE_MENU_CHECK_UPDATES_EVENT, checkUpdates);
    return () => {
      active=false;
      window.removeEventListener('legalwork-mail-notification-open',openMail);
      window.removeEventListener(NATIVE_MENU_OPEN_SETTINGS_EVENT, openSettings);
      window.removeEventListener(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, toggleSidebar);
      window.removeEventListener(NATIVE_MENU_CHECK_UPDATES_EVENT, checkUpdates);
    };
  }, [navigate, toggleSidebar]);

  return <>{children}</>;
}
