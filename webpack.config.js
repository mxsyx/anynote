/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')

module.exports = {
  mode: 'development',
  entry: './src/view/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js'
  },
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        test: /\.tsx$|\.ts$/,
        use: 'babel-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: [
          { loader: 'style-loader' },
          {
            loader: 'css-loader',
            options: {
              url: true,
              import: true,
              sourceMap: true,
              modules: {
                exportGlobals: true,
                localIdentName: '[folder]__[local]--[hash:base64:5]',
              },
              localsConvention: 'camelCase'
            }
          }
        ]
      },
      {
        test: /\.(png|jpg|gif)$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[name].[ext]',
              outputPath: 'assets'
            }
          }
        ]
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/view/index.html'
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/view/assets/tinymce', to: 'assets/tinymce' }
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, 'src'),
      "assets": path.resolve(__dirname, 'src/view/assets'),
      "store": path.resolve(__dirname, 'src/view/store'),
      "components": path.resolve(__dirname, 'src/view/components'),
      "constants": path.resolve(__dirname, 'src/view/constants'),
      "utils": path.resolve(__dirname, 'src/view/utils'),
      "initialize": path.resolve(__dirname, 'src/initialize')
    },
    extensions: ['.tsx', '.ts', '.js']
  },
  devServer: {
    contentBase: './dist'
  }
}
