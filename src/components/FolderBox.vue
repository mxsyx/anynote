<template>
  <ul 
    ref="folder"
    class="folder-box"
    :class="whichLevel"
    :style="{height: `${folderHeight}px`}"
  >
    <li  v-for="(folder, index) in folders" :key="folder.id">
      <a class="folder">
        <i
          class="fa fa-angle-right folder-angle" 
          @click="toggleSubfolder(index)">
        </i>
        <span class="folder-name">{{ folder.name }}</span>
        <span class="note-num">{{ folder.noteNum }}</span>
      </a>
      <FolderBox
        v-if="folder.hasSubfolder"
        :display="folder.display"
        :level="level + 1"
        :folders="folder.subfolders"
        @heightChanged="flushFolderHeight"
      />
    </li>
  </ul>
</template>

<script>
export default {
  name: 'FolderBox',

  props: {
    level: {
      type: Number,
      required: true
    },
    folders: {
      type: Array,
      required: true
    },
    display: {
      type: Boolean,
      required: true
    }
  },

  data() {
    return {
      folderHeight: 0,
    }
  },

  computed : {
    whichLevel() {
      return `level${this.level}`;
    }
  },

  mounted() {
    this.flushFolderHeight();
  },

  watch: {
    display: function() {
      this.flushFolderHeight();
    }
  },

  methods: {
    toggleSubfolder(folderId) {
      this.folders[folderId].display = !this.folders[folderId].display;
    },
    
    flushFolderHeight() {
      if (this.display) {
        this.$refs.folder.childNodes.forEach(ele => {
          this.folderHeight += ele.offsetHeight;
        })
      } else {
         this.folderHeight = 0;
      }
      this.$emit('heightChanged');
    },
    getFolderHeight() {
      return this.folderHeight;
    }
  }
}
</script>

<style scoped>
.folder-box {
  overflow: hidden;
  transition: all 0.3s;
}

.folder {
  display: grid;
  grid-template-columns: 12% 68% 20%;
  grid-template-rows: 100%;
  color: #ffffff;
  padding: 0.8rem 0rem;
  cursor: pointer;
  user-select: none;
}
.folder:hover {
  font-weight: 800;
}

.folder-angle {
  text-align: center;
}

.folder-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.level0 {
  margin-left: 0rem;
  font-size: 1.5rem;
}

.level1 {
  margin-left: 1rem;
  font-size: 1.4rem;
}
</style>