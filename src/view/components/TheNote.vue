<template>
  <div id="note">
    <div id="note-head">
      <input id="note-title" type="text" v-model="title">
      <span id="note-opts">
        <i class="fa fa-pencil-square-o" aria-hidden="true"></i>
        <i class="fa fa-save" aria-hidden="true"></i>
        <i class="fa fa-expand" aria-hidden="true"></i>
      </span>
      <div id="note-meta">
        <span>创建：2020-01-30 11:59:02</span>
        <span>修改：2020-03-26 14:37:33</span>
      </div>
    </div>
    <Editor
      id="tinymce"
      v-model="content"
      :init="editorInit"
      @tinymce-ready="initShortcuts"
    />
  </div>
</template>

<script>
import tinymce from 'tinymce/tinymce'
import Editor from '@tinymce/tinymce-vue'
import 'tinymce/themes/silver'
import '../assets/tinymce/skins/ui/oxide/skin.min.css'
import lang from '../assets/tinymce/zh_CN.js'

const ipcRenderer = window.electron.ipcRenderer;


import 'font-awesome/css/font-awesome.min.css'

// TinyMce plugins
import 'tinymce/plugins/image'
import 'tinymce/plugins/link'
import 'tinymce/plugins/code'
import 'tinymce/plugins/table'
import 'tinymce/plugins/lists'
import 'tinymce/plugins/contextmenu'
import 'tinymce/plugins/wordcount'
import 'tinymce/plugins/colorpicker'
import 'tinymce/plugins/textcolor'


export default {
  name: 'TheNote',

  components: {
    Editor
  },

  data() {
    return {
      editorInit: {
        width: "100%",
        height: "calc(100vh - 6rem)",
        language: 'zh_CN',
        plugins: 'link lists image code table colorpicker textcolor wordcount contextmenu',
        toolbar: 'undo redo | bold italic underline strikethrough | fontsizeselect | forecolor backcolor | alignleft aligncenter alignright alignjustify | bullist numlist | outdent indent blockquote | link unlink image code | removeformat',
        branding: false,
        contextmenu: "copy",
        statusbar: false,
        menubar: false,
      },
      title: '',
      content: '',
    }
  },

  mounted() {
    tinymce.init({});
    tinymce.addI18n('zh_CN', lang);
    console.log('xx')
    window.onkeydown = (event) => {
      if (event.ctrlKey && event.keyCode == 83) {
        this.save();
      }
    }
  },

  methods: {
    initShortcuts() {
      window.onkeydown = window.frames[0].onkeydown = (event) => {
        if (event.ctrlKey && event.keyCode == 83) {
          this.save();
        }
      }
    },
    save() {
      ipcRenderer.send('noteContentChanged', this.content)
    }
  }
}
</script>

<style scoped>
#note-title {
  height: 2rem;
  font-size: 2rem;
  padding: 0.5rem;
  width: 80%;
  box-sizing: border-box;
}

#note-opts {
  width: 20%;
  display: inline-block;
  text-align: right;
}

#note-opts i {
  font-size: 1.6rem;
  cursor: pointer;
  padding: 0.7rem;
}

#note-meta {
  font-size: 1.4rem;
  line-height: 1.4rem;
  background: #f0f0f0;
  padding: 0.8rem 0rem;
}

#note-meta span {
  padding: 1rem;
}
</style>