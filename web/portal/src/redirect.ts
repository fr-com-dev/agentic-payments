// The sign-in redirect page (specs/013 research R10): runs only the sign-in library's bridge, which passes the
// authorization response to the window that started the sign-in. Nothing else may be imported here.
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

void broadcastResponseToMainFrame();
