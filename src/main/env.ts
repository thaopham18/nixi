import { app } from 'electron'

// Must run before the stores are created. Lets tests and side-by-side profiles use a separate data folder.
if (process.env.NIXI_USER_DATA) app.setPath('userData', process.env.NIXI_USER_DATA)
