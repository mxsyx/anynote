"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
var typeorm_1 = require("typeorm");
var Note = /** @class */ (function (_super) {
    __extends(Note, _super);
    function Note() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    __decorate([
        typeorm_1.PrimaryColumn({ type: 'text', name: 'id', length: 36, nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "id", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'type', length: 1, nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "type", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'title', length: 140, nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "title", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'c_time', nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "cTime", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'u_time', nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "uTime", void 0);
    __decorate([
        typeorm_1.Column({ type: 'integer', name: 'word_count', unsigned: true, nullable: false }),
        __metadata("design:type", Number)
    ], Note.prototype, "wordCount", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'author', length: 28, default: null }),
        __metadata("design:type", String)
    ], Note.prototype, "author", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'link', length: 255, default: null }),
        __metadata("design:type", String)
    ], Note.prototype, "link", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'lisence', length: 16, default: null }),
        __metadata("design:type", String)
    ], Note.prototype, "lisence", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'remark', length: 800, default: null }),
        __metadata("design:type", String)
    ], Note.prototype, "remark", void 0);
    __decorate([
        typeorm_1.Column({ type: 'text', name: 'content', nullable: false }),
        __metadata("design:type", String)
    ], Note.prototype, "content", void 0);
    __decorate([
        typeorm_1.Column({ type: 'integer', name: 'version', unsigned: true, nullable: false }),
        __metadata("design:type", Number)
    ], Note.prototype, "version", void 0);
    Note = __decorate([
        typeorm_1.Entity()
    ], Note);
    return Note;
}(typeorm_1.BaseEntity));
exports.Note = Note;
//# sourceMappingURL=Note.js.map