<template>
  <ul
    ref="folderBox"
    :style="{height: `${folderBoxHeight * expand}px`}"
    class="folder-box"
    :class=" `level${level}`"
  >
    <li v-for="(folder, index) in folders" :key="folder.id">
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
        :ref="folder.id"
        :level="level + 1"
        :expand="folder.expand"
        :folders="folder.subfolders"
        @expanded="handleExpanded"
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
    expand: {
      type: Number,
      required: true
    },
    folders: {
      type: Array,
      required: true
    },
  },

  data() {
    return {
      folderBoxHeight: 0
    }
  },

  watch: {
    expand() {
      if (this.expand == 1) {
        this.$emit('expanded', this.folderBoxHeight);
      } else {
        this.$emit('expanded', -this.folderBoxHeight);
      }
    }
  },

  mounted() {
    this.initFolderBoxHeight();
  },

  methods: {
    toggleSubfolder(index) {
      this.folders[index].expand = 
          this.folders[index].expand == 0 ? 1 : 0;
    },

    initFolderBoxHeight() {
      this.$refs.folderBox.childNodes.forEach(ele => {
        this.folderBoxHeight += ele.offsetHeight;
      })
    },
    
    handleExpanded(height) {
      this.folderBoxHeight += height;
      this.$emit('expanded', height);
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
  margin-left: 0.8rem;
  font-size: 1.4rem;
}

.level2 {
  margin-left: 1.2rem;
  font-size: 1.3rem;
}

.hide {
  height: 0px !important;
  overflow: hidden;
}
</style>