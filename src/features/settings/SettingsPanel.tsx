import {
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Link,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useRuntimeSettings } from "./runtimeSettings";

export function SettingsPanel() {
  const {
    settings,
    setUseMainThreadRender,
    setForceSoftwareWebCodecs,
    setMaxConcurrency,
    resetSettings,
  } = useRuntimeSettings();

  return (
    <Stack spacing={2.2}>
      <Typography variant="h4" fontWeight={800}>
        设置
      </Typography>
      <Typography color="text.secondary">配置运行模式与并发参数。</Typography>

      <Card sx={{ borderRadius: 1.25 }}>
        <CardContent>
          <Stack spacing={1.4}>
            <FormControlLabel
              control={
                <Switch
                  checked={settings.useMainThreadRender}
                  onChange={(event) => setUseMainThreadRender(event.target.checked)}
                />
              }
              label="使用主线程渲染（仅调试）"
            />

            <FormControlLabel
              control={
                <Switch
                  checked={settings.forceSoftwareWebCodecs}
                  onChange={(event) => setForceSoftwareWebCodecs(event.target.checked)}
                />
              }
              label="使用软件解码（仅调试）"
            />
            <Typography variant="body2" color="text.secondary">
              强制使用 libav.js 软件编解码，忽略浏览器的硬件 WebCodecs 实现。
            </Typography>

            <TextField
              type="number"
              label="最大并发数"
              value={settings.maxConcurrency}
              inputProps={{ min: 1, step: 1 }}
              onChange={(event) => setMaxConcurrency(Number(event.target.value))}
              helperText="默认会根据设备内存和 CPU 自动估算，仅在 Worker 渲染模式下生效。"
            />

            <Divider />

            <Button variant="outlined" color="warning" onClick={resetSettings}>
              重置设置
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ borderRadius: 1.25 }}>
        <CardContent>
          <Stack spacing={0.9}>
            <Typography fontWeight={700}>关于</Typography>
            <Typography variant="body2" color="text.secondary">
              版本: v{__APP_VERSION__} (GitHub:{" "}
              <Link href="https://github.com/FurryR/watermark">FurryR/watermark</Link>)
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Made with love by FurryR
            </Typography>
            <Typography variant="body2" color="text.secondary">
              GitHub:{" "}
              <Link href="https://github.com/FurryR" target="_blank" rel="noopener noreferrer">
                https://github.com/FurryR
              </Link>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              X:{" "}
              <Link href="https://x.com/im_furryr" target="_blank" rel="noopener noreferrer">
                @im_furryr
              </Link>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Website:{" "}
              <Link href="https://furryr.is-a.dev" target="_blank" rel="noopener noreferrer">
                furryr.is-a.dev
              </Link>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              协助托管：{" "}
              <Link href="https://github.com/foxderin" target="_blank" rel="noopener noreferrer">
                @foxderin (玻狸)
              </Link>
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
