'use client';

import { createTheme } from '@mui/material/styles';

declare module '@mui/material/styles' {
  interface Palette {
    borderColor: string;
    borderColorLight: string;
    borderColorIntensive: string;
    bgGray: string;
    bgGray0: string;
    bgLightGray: string;
    bgLightGray2: string;
    varcolorRed: string;
    varcolorOrange: string;
    varcolorYellow: string;
    varcolorGreen: string;
    varcolorCyan: string;
    varcolorBlue: string;
    varcolorMargenta: string;
  }
  interface PaletteOptions {
    borderColor?: string;
    borderColorLight?: string;
    borderColorIntensive?: string;
    bgGray?: string;
    bgGray0?: string;
    bgLightGray?: string;
    bgLightGray2?: string;
    varcolorRed?: string;
    varcolorOrange?: string;
    varcolorYellow?: string;
    varcolorGreen?: string;
    varcolorCyan?: string;
    varcolorBlue?: string;
    varcolorMargenta?: string;
  }
  interface Theme {
    customButton: object;
    customButtonOutline: object;
  }
  interface ThemeOptions {
    customButton?: object;
    customButtonOutline?: object;
  }
}

const baseTheme = createTheme({
  palette: {
    primary: {
      main: '#555',
      contrastText: '#fff',
    },
    secondary: {
      main: '#fff',
      contrastText: '#333',
    },
    error: {
      main: '#0055FF',
      contrastText: '#FF0000',
    },
    text: {
      primary: '#333',
      secondary: '#666',
    },
    divider: '#eee',
    background: {
      default: '#f8f8f8',
      paper: '#fff',
    },
    borderColor: '#fff',
    borderColorLight: '#efefef',
    borderColorIntensive: '#ddd',
    bgGray: 'linear-gradient(270deg, rgba(253, 253, 253, 1), rgba(254, 254, 254, 0.5))',
    bgGray0: `
      linear-gradient(90deg,
        rgba(255, 255, 255, 0) 0%,
        rgba(255, 255, 255, 0.8) 25%,
        rgba(255, 255, 255, 1) 40%,
        rgba(255, 255, 255, 1) 60%,
        rgba(255, 255, 255, 0.8) 75%,
        rgba(255, 255, 255, 0) 100%),
      linear-gradient(0deg,
        rgba(0, 0, 0, 0.03) 0%,
        rgba(0, 0, 0, 0.0) 2%),
      linear-gradient(0deg,
        rgba(0, 0, 0, 0.01) 0%,
        rgba(0, 0, 0, 0.0) 30%),
      linear-gradient(0deg,
        rgba(250, 250, 250, 1) 0%,
        rgba(255, 255, 255, 1) 50%)
    `,
    bgLightGray: 'rgba(250,251,252,1)',
    bgLightGray2: 'rgba(250,251,252,0.0)',
    varcolorRed: 'rgba(255, 100, 100, 0.7)',
    varcolorOrange: 'rgba(250, 100, 50, 0.8)',
    varcolorYellow: 'rgba(255, 190, 50, 1)',
    varcolorGreen: 'rgba(150, 255, 150, 0.7)',
    varcolorCyan: 'rgba(50, 250, 255, 0.7)',
    varcolorBlue: 'rgba(100, 180, 255, 0.7)',
    varcolorMargenta: 'rgba(250, 100, 250, 0.7)',
  },
  typography: {
    fontFamily: ['"Roboto"', 'sans-serif'].join(','),
  },
  components: {
    MuiTypography: {
      variants: [
        {
          props: { variant: 'subtitle1' },
          style: {
            display: 'block',
            fontSize: '1.1rem',
            lineHeight: '1.6rem',
            marginBlockStart: '1.33em',
            marginBlockEnd: '1.33em',
          },
        },
      ],
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#fff',
          color: '#333',
        },
      },
    },
  },
});

const theme = {
  ...baseTheme,
  customButton: {
    whiteSpace: 'nowrap',
    minWidth: 'auto',
    borderRadius: '5px',
    padding: baseTheme.spacing(0.5),
    paddingInline: baseTheme.spacing(1.5),
    border: '1px solid #777',
    textTransform: 'none',
    color: baseTheme.palette.text.primary,
    backgroundColor: 'transparent',
    '&:hover': {
      border: '1px solid #0ff',
      background: '#fff',
    },
    [baseTheme.breakpoints.down('md')]: {
      paddingInline: baseTheme.spacing(1.5),
      width: '100%',
      fontSize: baseTheme.typography.body2.fontSize,
    },
    [baseTheme.breakpoints.up('md')]: {
      fontSize: baseTheme.typography.body1.fontSize,
    },
  },
  customButtonOutline: {
    whiteSpace: 'nowrap',
    minWidth: 'auto',
    border: '1px solid #00efdf',
    borderRadius: '5px',
    color: '#000',
    textTransform: 'none',
    padding: baseTheme.spacing(0.5),
    paddingInline: baseTheme.spacing(1.5),
    background: `linear-gradient(90deg,
      rgba(150, 246, 215, 1) 0%,
      rgba(153, 230, 231, 1) 100%
    )`,
    '&:hover': {
      border: '1px solid #0ff',
      color: '#000',
      background: '#fff',
    },
    [baseTheme.breakpoints.down('md')]: {
      paddingInline: baseTheme.spacing(1.5),
      width: '100%',
      fontSize: baseTheme.typography.body2.fontSize,
    },
    [baseTheme.breakpoints.up('md')]: {
      fontSize: baseTheme.typography.body1.fontSize,
    },
  },
};

export default theme;
