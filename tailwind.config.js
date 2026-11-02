/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        medical: {
          blue: '#0066cc',
          green: '#00aa44',
          red: '#cc3300'
        }
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms')
  ],
}